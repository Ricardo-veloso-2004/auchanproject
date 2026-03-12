const express = require('express');
const mysql = require('mysql2/promise'); 
const axios = require('axios'); 
const xml2js = require('xml2js'); 
const util = require('util');

const app = express();
const porta = 3000;

app.use(express.json()); 
app.use(express.static('public')); 

// Converter o parser de XML para formato Promise (Async/Await)
const parseXmlAsync = util.promisify(xml2js.parseString);

// ==========================================
// CONFIGURAÇÃO DA BASE DE DADOS (USANDO POOL)
// ==========================================
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'gestao_reciclagem',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Constantes APA
const APA_ENDPOINT = 'https://qualsiliamb.apambiente.pt/services/egar/GuiaAcompanhamentoWs/v2';
const TOKEN_CERTIFICACAO = 'gDJI6KKfRoUjT3IQ'; 
const NIF_EMPRESA = '508391687';
const PASSWORD_SILIAMB = '1234'; 

// ==========================================
// MOTOR DE RECONCILIAÇÃO E FATURAÇÃO (BLINDADO)
// ==========================================
async function reconciliarGuiasEPrecos() {
    try {
        console.log("A iniciar motor de reconciliação...");

        // 1. Ligar Guias a Lojas (REGEXP_REPLACE remove TUDO o que não seja letras ou números)
        await pool.query(`
            UPDATE guias_siliamb g
            JOIN estabelecimentos e ON 
                UPPER(REGEXP_REPLACE(g.produtor_apa_raw, '[^a-zA-Z0-9]', '')) = UPPER(REGEXP_REPLACE(e.codigo_apa, '[^a-zA-Z0-9]', ''))
            SET g.estabelecimento_id = e.id
            WHERE g.estabelecimento_id IS NULL
        `);

        // 2. Ligar Guias a Materiais (REGEXP_REPLACE foca apenas nos números, ignorando espaços e pontos)
        await pool.query(`
            UPDATE guias_siliamb g
            JOIN materiais m ON 
                REGEXP_REPLACE(g.residuo_ler_raw, '[^0-9]', '') = REGEXP_REPLACE(m.codigo_ler, '[^0-9]', '')
            SET g.material_id = m.id
            WHERE g.material_id IS NULL
        `);

        // 3. Forçar Recálculo de Guias Sem Preço (NULL ou 0.00)
        const [guiasPendentes] = await pool.query(`
            SELECT g.id, g.peso_kg, g.data_emissao, g.material_id, e.cliente_id 
            FROM guias_siliamb g
            JOIN estabelecimentos e ON g.estabelecimento_id = e.id
            WHERE g.estabelecimento_id IS NOT NULL 
              AND g.material_id IS NOT NULL 
              AND (g.preco_aplicado IS NULL OR g.preco_aplicado = 0.00)
        `);

        for (const guia of guiasPendentes) {
            const [cotacoes] = await pool.query(`
                SELECT preco_tonelada 
                FROM cotacoes 
                WHERE material_id = ? 
                  AND (cliente_id = ? OR cliente_id IS NULL)
                ORDER BY cliente_id DESC 
                LIMIT 1
            `, [guia.material_id, guia.cliente_id]);

            const precoTon = cotacoes.length > 0 ? cotacoes[0].preco_tonelada : 0;
            const valorTotal = (guia.peso_kg / 1000) * precoTon;

            await pool.query(`
                UPDATE guias_siliamb 
                SET preco_aplicado = ?, valor_total = ? 
                WHERE id = ?
            `, [precoTon, valorTotal, guia.id]);
        }
        console.log("Motor de reconciliação concluído com sucesso.");
    } catch (e) {
        console.error("Erro no motor de reconciliação:", e);
    }
}

// ==========================================
// ROTA: CONSULTAR NA APA (COM PAGINAÇÃO)
// ==========================================
app.get('/api/siliamb/consultar', async (req, res) => {
    let todasAsGuias = [];
    let paginaAtual = 1;
    const numeroElementos = 50; 
    let totalGuiasAPA = 0;
    let sucessoGeral = false;

    try {
        while (true) {
            console.log(`A consultar APA: Página ${paginaAtual}...`);
            
            const xmlPedido = `
            <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://pt.apa.guiaacompanhamento/v2">
               <soapenv:Header><wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><wsse:UsernameToken><wsse:Username>${NIF_EMPRESA}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${PASSWORD_SILIAMB}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header>
               <soapenv:Body><v2:consultarGuias><arg0><tokenCertificacao>${TOKEN_CERTIFICACAO}</tokenCertificacao><nifInterveniente>${NIF_EMPRESA}</nifInterveniente><interveniente>D</interveniente><paginaPesquisar>${paginaAtual}</paginaPesquisar><numeroElementos>${numeroElementos}</numeroElementos></arg0></v2:consultarGuias></soapenv:Body>
            </soapenv:Envelope>`.trim();

            const respostaAPA = await axios.post(APA_ENDPOINT, xmlPedido, { headers: { 'Content-Type': 'text/xml;charset=UTF-8' } });
            const result = await parseXmlAsync(respostaAPA.data, { explicitArray: false, ignoreAttrs: true });
            const base = result['soap:Envelope']['soap:Body']['ns2:consultarGuiasResponse']['return'];
            
            if (base.result.codigo !== "100") {
                console.error("Erro da APA:", base.result.mensagem);
                break;
            }

            sucessoGeral = true;
            totalGuiasAPA = parseInt(base.numeroTotal) || 0;

            if (totalGuiasAPA > 0 && base.guias) {
                const guiasDestaPagina = Array.isArray(base.guias) ? base.guias : [base.guias];
                todasAsGuias = todasAsGuias.concat(guiasDestaPagina);
                if (guiasDestaPagina.length < numeroElementos) break; 
            } else {
                break; 
            }

            if (todasAsGuias.length >= totalGuiasAPA) break; 
            paginaAtual++;
        }

        res.json({ sucesso: sucessoGeral, total: todasAsGuias.length, lista: todasAsGuias });

    } catch (erro) { 
        console.error("Erro no ciclo de paginação da APA:", erro);
        res.status(500).json({ sucesso: false, mensagem: "Erro de comunicação com a APA" }); 
    }
});

// ==========================================
// ROTA: SINCRONIZAR (COM DADOS TÉCNICOS OFICIAIS v2) E PROTEÇÕES
// ==========================================
app.post('/api/siliamb/sincronizar', async (req, res) => {
    try {
        const guias = req.body.guias;
        if (!guias || !Array.isArray(guias)) return res.status(400).json({ sucesso: false });

        for (const guia of guias) {
            const numGuia = guia.numeroGuia;
            const estado = guia.descricaoEstado;
            const dataEmissao = guia.dataEstado.split('T')[0];
            const url = guia.url ? guia.url.replace(/&amp;/g, '&') : null;

            // Extração segura usando encadeamento opcional (?.) para evitar que a app rebente se um nó do XML falhar
            const codApa = guia.remetente?.estabelecimento?.codigoAPA?.trim() || '';
            const prodNome = guia.remetente?.nome?.trim() || '';
            
            let codLer = guia.residuoTransportado?.codigoResiduoLer?.trim() || '';
            let descLer = guia.residuoTransportado?.designacao?.trim() || '';
            let pesoFinal = parseFloat(guia.residuoTransportado?.quantidade || 0);

            // Substituir pelos dados corrigidos (se existirem)
            if (guia.residuoTransportadoCorrigido) {
                if (guia.residuoTransportadoCorrigido.quantidadeCorrigido) {
                    pesoFinal = parseFloat(guia.residuoTransportadoCorrigido.quantidadeCorrigido);
                }
                if (guia.residuoTransportadoCorrigido.codigoResiduoLerCorrigido) {
                    codLer = guia.residuoTransportadoCorrigido.codigoResiduoLerCorrigido.trim();
                }
                if (guia.residuoTransportadoCorrigido.descricaoResiduo) {
                    descLer = guia.residuoTransportadoCorrigido.descricaoResiduo.trim();
                }
            }

            const [existe] = await pool.query('SELECT id FROM guias_siliamb WHERE numero_guia = ?', [numGuia]);

            if (existe.length > 0) {
                await pool.query(`
                    UPDATE guias_siliamb 
                    SET estado = ?, peso_kg = ?, residuo_ler_raw = ?, residuo_desc_raw = ?, data_emissao = ?, url_guia = ?
                    WHERE numero_guia = ?
                `, [estado, pesoFinal, codLer, descLer, dataEmissao, url, numGuia]);
            } else {
                await pool.query(`
                    INSERT INTO guias_siliamb 
                    (numero_guia, produtor_nome_raw, produtor_apa_raw, residuo_ler_raw, residuo_desc_raw, peso_kg, estado, data_emissao, url_guia) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [numGuia, prodNome, codApa, codLer, descLer, pesoFinal, estado, dataEmissao, url]);
            }
        }
        
        // CORREÇÃO: Arrancar sempre o motor após guardar na BD para ligar dados novos
        await reconciliarGuiasEPrecos();

        res.json({ sucesso: true, mensagem: "Sincronização concluída com base na ficha técnica eGAR v2." });
    } catch (erro) {
        console.error("Erro na sincronização:", erro);
        res.status(500).json({ sucesso: false });
    }
});

// ==========================================
// PENDENTES & DASHBOARD & GUIAS
// ==========================================
app.get('/api/reconciliacao/pendentes', async (req, res) => {
    try {
        const [lojas] = await pool.query(`SELECT TRIM(produtor_apa_raw) AS codigo_apa, MAX(produtor_nome_raw) AS nome, COUNT(*) as total_guias FROM guias_siliamb WHERE estabelecimento_id IS NULL GROUP BY TRIM(produtor_apa_raw)`);
        const [materiais] = await pool.query(`SELECT TRIM(residuo_ler_raw) AS codigo_ler, MAX(residuo_desc_raw) AS descricao, COUNT(*) as total_guias FROM guias_siliamb WHERE material_id IS NULL GROUP BY TRIM(residuo_ler_raw)`);
        res.json({ sucesso: true, total_pendentes: lojas.length + materiais.length, lojas, materiais });
    } catch (e) { res.status(500).json({ sucesso: false, erro: e.message }); }
});

app.get('/guias', async (req, res) => {
    try {
        const [resultados] = await pool.query(`
            SELECT g.id, g.numero_guia, g.peso_kg, g.estado, g.data_emissao, g.url_guia,
                   g.estabelecimento_id, g.material_id,
                   c.nome AS nome_cliente,
                   COALESCE(e.nome_loja, g.produtor_nome_raw) AS nome_loja,
                   COALESCE(m.descricao, g.residuo_desc_raw) AS material
            FROM guias_siliamb g
            LEFT JOIN estabelecimentos e ON g.estabelecimento_id = e.id
            LEFT JOIN clientes c ON e.cliente_id = c.id
            LEFT JOIN materiais m ON g.material_id = m.id
            ORDER BY g.data_emissao DESC
        `);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/dashboard-stats', async (req, res) => {
    try {
        const stats = {};
        const [pendentes] = await pool.query("SELECT COUNT(*) AS total FROM guias_siliamb WHERE estado = 'Emitida'");
        stats.guiasPendentes = pendentes[0].total;
        const [clientes] = await pool.query("SELECT COUNT(*) AS total FROM clientes");
        stats.totalClientes = clientes[0].total;
        const [tabela] = await pool.query(`
            SELECT g.numero_guia, g.peso_kg, g.data_emissao, c.nome AS nome_cliente, COALESCE(e.nome_loja, g.produtor_nome_raw) AS nome_loja, COALESCE(m.descricao, g.residuo_desc_raw) AS material
            FROM guias_siliamb g
            LEFT JOIN estabelecimentos e ON g.estabelecimento_id = e.id
            LEFT JOIN clientes c ON e.cliente_id = c.id
            LEFT JOIN materiais m ON g.material_id = m.id
            WHERE g.estado = 'Emitida' ORDER BY g.data_emissao DESC LIMIT 5
        `);
        stats.tabelaPendentes = tabela;
        const [grafico] = await pool.query(`
            SELECT COALESCE(m.descricao, g.residuo_desc_raw) AS descricao, SUM(g.peso_kg) AS total_peso
            FROM guias_siliamb g
            LEFT JOIN materiais m ON g.material_id = m.id
            WHERE g.estado IN ('Corrigida', 'Aceite', 'Concluída') 
              AND MONTH(g.data_emissao) = MONTH(CURRENT_DATE()) 
              AND YEAR(g.data_emissao) = YEAR(CURRENT_DATE())
            GROUP BY COALESCE(m.descricao, g.residuo_desc_raw)
        `);
        stats.graficoMateriais = grafico;
        const [lojas] = await pool.query(`SELECT DISTINCT estabelecimento_id AS id FROM guias_siliamb WHERE estado = 'Emitida' AND estabelecimento_id IS NOT NULL`);
        stats.lojasComPendentes = lojas.map(r => r.id);
        res.json(stats);
    } catch (e) { res.status(500).send(e.message); }
});

// ==========================================
// CLIENTES, SEDES E LOJAS
// ==========================================
app.post('/clientes', async (req, res) => {
    try {
        const { nome, nif, morada_faturacao, email_faturacao, telefone } = req.body;
        await pool.query('INSERT INTO clientes (nome, nif, morada_faturacao, email_faturacao, telefone) VALUES (?, ?, ?, ?, ?)', [nome.trim(), nif.trim(), morada_faturacao, email_faturacao, telefone]);
        res.status(201).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/clientes', async (req, res) => {
    try {
        const [resultados] = await pool.query(`
            SELECT c.id AS cliente_id, c.nome AS Sede, c.nif, c.telefone, c.email_faturacao, c.morada_faturacao, 
                   e.id AS loja_id, e.nome_loja AS Loja, e.codigo_apa, e.morada_local AS morada_loja 
            FROM clientes c 
            LEFT JOIN estabelecimentos e ON e.cliente_id = c.id 
            ORDER BY c.nome, e.nome_loja
        `);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/sedes', async (req, res) => {
    try {
        const [resultados] = await pool.query('SELECT * FROM clientes ORDER BY nome');
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/lojas', async (req, res) => {
    try {
        const [resultados] = await pool.query(`SELECT e.*, c.nome AS sede_nome FROM estabelecimentos e JOIN clientes c ON e.cliente_id = c.id ORDER BY c.nome, e.nome_loja`);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/estabelecimentos', async (req, res) => {
    try {
        const { cliente_id, nome_loja, codigo_apa, morada_local } = req.body;
        await pool.query(`INSERT INTO estabelecimentos (cliente_id, nome_loja, codigo_apa, morada_local) VALUES (?, ?, ?, ?)`, [cliente_id, nome_loja.trim(), codigo_apa.trim(), morada_local]);
        await reconciliarGuiasEPrecos();
        res.status(201).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ==========================================
// MATERIAIS E COTAÇÕES
// ==========================================
app.post('/materiais', async (req, res) => {
    try {
        const { codigo_ler, descricao } = req.body;
        await pool.query('INSERT INTO materiais (codigo_ler, descricao) VALUES (?, ?)', [codigo_ler.trim(), descricao.trim()]);
        await reconciliarGuiasEPrecos();
        res.status(201).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/materiais', async (req, res) => {
    try {
        const [resultados] = await pool.query(`SELECT m.id, m.codigo_ler, m.descricao, (SELECT AVG(c.preco_tonelada) FROM cotacoes c INNER JOIN (SELECT cliente_id, MAX(id) as max_id FROM cotacoes WHERE material_id = m.id AND cliente_id IS NOT NULL GROUP BY cliente_id) latest ON c.id = latest.max_id) AS preco_atual FROM materiais m`);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/cotacoes', async (req, res) => {
    try {
        const { material_id, cliente_id, preco_tonelada, data_inicio } = req.body;
        const [existe] = await pool.query('SELECT id FROM cotacoes WHERE material_id = ? AND cliente_id = ?', [material_id, cliente_id]);

        if (existe.length > 0) {
            await pool.query('UPDATE cotacoes SET preco_tonelada = ?, data_inicio = ? WHERE id = ?', [preco_tonelada, data_inicio, existe[0].id]);
        } else {
            await pool.query('INSERT INTO cotacoes (material_id, cliente_id, preco_tonelada, data_inicio) VALUES (?, ?, ?, ?)', [material_id, cliente_id, preco_tonelada, data_inicio]);
        }

        await pool.query(`
            UPDATE guias_siliamb g
            JOIN estabelecimentos e ON g.estabelecimento_id = e.id
            SET g.preco_aplicado = ?, g.valor_total = (g.peso_kg / 1000) * ?
            WHERE g.material_id = ? AND e.cliente_id = ?
        `, [preco_tonelada, preco_tonelada, material_id, cliente_id]);
        
        await reconciliarGuiasEPrecos(); 
        res.status(200).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/cotacoes-clientes', async (req, res) => {
    try {
        const [resultados] = await pool.query(`SELECT m.codigo_ler, m.descricao AS material, cl.nome AS cliente, c.preco_tonelada, c.data_inicio FROM cotacoes c JOIN materiais m ON c.material_id = m.id JOIN clientes cl ON c.cliente_id = cl.id ORDER BY cl.nome, m.descricao, c.data_inicio DESC`);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

// ==========================================
// SERVIÇOS
// ==========================================
app.post('/servicos', async (req, res) => {
    try {
        await pool.query('INSERT INTO servicos (descricao, tipo) VALUES (?, ?)', [req.body.descricao, req.body.tipo]);
        res.status(201).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/servicos', async (req, res) => {
    try {
        const [resultados] = await pool.query(`
            SELECT s.id, s.descricao, s.tipo, 
                   (SELECT AVG(sc.valor) 
                    FROM servicos_contratados sc 
                    INNER JOIN (
                        SELECT estabelecimento_id, MAX(id) as max_id 
                        FROM servicos_contratados 
                        WHERE servico_id = s.id 
                        GROUP BY estabelecimento_id
                    ) latest ON sc.id = latest.max_id) AS preco_medio 
            FROM servicos s
        `);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/servicos-contratados', async (req, res) => {
    try {
        await pool.query('INSERT INTO servicos_contratados (estabelecimento_id, servico_id, valor, data_inicio) VALUES (?, ?, ?, ?)', [req.body.estabelecimento_id, req.body.servico_id, req.body.valor, req.body.data_inicio]);
        res.status(201).json({ mensagem: 'OK' });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/servicos-contratados', async (req, res) => {
    try {
        const [resultados] = await pool.query(`SELECT sc.id, e.nome_loja, s.descricao AS servico, s.tipo, sc.valor, sc.data_inicio FROM servicos_contratados sc JOIN estabelecimentos e ON sc.estabelecimento_id = e.id JOIN servicos s ON sc.servico_id = s.id ORDER BY e.nome_loja`);
        res.json(resultados);
    } catch (e) { res.status(500).send(e.message); }
});

// ==========================================
// FATURAÇÃO 
// ==========================================
app.get('/faturacao/:cliente_id', async (req, res) => {
    try {
        await reconciliarGuiasEPrecos(); 
        const cliente_id = req.params.cliente_id;
        const { inicio, fim } = req.query; 

        if (!inicio || !fim) return res.status(400).json({ erro: "É obrigatório enviar data de início e fim." });
        
        // 1. Pesquisa de GUIAS Faturáveis
        const [guias] = await pool.query(`
            SELECT e.nome_loja, m.descricao AS material, g.peso_kg, g.estado, g.numero_guia, g.data_emissao, 
                   g.preco_aplicado AS preco_tonelada, g.valor_total AS valor_calculado
            FROM guias_siliamb g 
            JOIN estabelecimentos e ON g.estabelecimento_id = e.id 
            JOIN materiais m ON g.material_id = m.id 
            WHERE e.cliente_id = ? 
              AND g.valor_total IS NOT NULL
              AND g.estado IN ('Corrigida', 'Aceite', 'Concluída')
              AND g.data_emissao >= ? 
              AND g.data_emissao <= ?
            ORDER BY g.data_emissao DESC
        `, [cliente_id, inicio, fim]);

        // 2. Pesquisa de Serviços RECORRENTES
        const [servicosRecorrentes] = await pool.query(`
            SELECT e.nome_loja, s.descricao AS servico, sc.valor, s.tipo 
            FROM servicos_contratados sc 
            JOIN estabelecimentos e ON sc.estabelecimento_id = e.id 
            JOIN servicos s ON sc.servico_id = s.id 
            WHERE e.cliente_id = ? AND s.tipo = 'recorrente' AND sc.data_inicio <= ? 
        `, [cliente_id, fim]);

        // 3. Pesquisa de Serviços PONTUAIS
        const [servicosPontuais] = await pool.query(`
            SELECT e.nome_loja, 
                   CONCAT(s.descricao, ' (', COUNT(DISTINCT g.data_emissao), ' recolhas)') AS servico, 
                   (sc.valor * COUNT(DISTINCT g.data_emissao)) AS valor, 
                   s.tipo 
            FROM servicos_contratados sc 
            JOIN estabelecimentos e ON sc.estabelecimento_id = e.id 
            JOIN servicos s ON sc.servico_id = s.id 
            JOIN guias_siliamb g ON g.estabelecimento_id = e.id
            WHERE e.cliente_id = ? AND s.tipo = 'pontual' AND g.estado IN ('Corrigida', 'Aceite', 'Concluída') AND g.data_emissao >= ? AND g.data_emissao <= ?
            GROUP BY e.id, s.id, sc.valor, s.descricao, s.tipo
            HAVING COUNT(DISTINCT g.data_emissao) > 0
        `, [cliente_id, inicio, fim, inicio, fim]);

        // 4. NOVA PESQUISA: Guias Emitidas (Esquecidas)
        const [emitidas] = await pool.query(`
            SELECT COUNT(*) AS total 
            FROM guias_siliamb g 
            JOIN estabelecimentos e ON g.estabelecimento_id = e.id 
            WHERE e.cliente_id = ? 
              AND g.estado = 'Emitida' 
              AND g.data_emissao >= ? 
              AND g.data_emissao <= ?
        `, [cliente_id, inicio, fim]);

        const servicos = [...servicosRecorrentes, ...servicosPontuais];
        let totalResiduos = guias.reduce((acc, g) => acc + parseFloat(g.valor_calculado), 0);
        let totalServicos = servicos.reduce((acc, s) => acc + parseFloat(s.valor), 0);

        res.json({ 
            guias, 
            servicos, 
            pendentes: emitidas[0].total, // <-- ENVIAMOS A CONTAGEM PARA O FRONTEND
            totais: { residuos: totalResiduos.toFixed(2), servicos: totalServicos.toFixed(2), balanco: (totalResiduos - totalServicos).toFixed(2) } 
        });
    } catch (e) { res.status(500).send(e.message); }
});

// ==========================================
// APAGAR / ATUALIZAR (DELETE / PUT)
// ==========================================
app.delete('/clientes/:id', async (req, res) => {
    try { await pool.query('DELETE FROM clientes WHERE id = ?', [req.params.id]); res.json({ mensagem: 'OK' }); } 
    catch (e) { res.status(500).send(e.message); }
});

app.delete('/estabelecimentos/:id', async (req, res) => {
    try { await pool.query('DELETE FROM estabelecimentos WHERE id = ?', [req.params.id]); res.json({ mensagem: 'OK' }); } 
    catch (e) { res.status(500).send(e.message); }
});

app.put('/clientes/:id', async (req, res) => {
    try {
        await pool.query('UPDATE clientes SET nome=?, nif=?, morada_faturacao=?, telefone=?, email_faturacao=? WHERE id=?', 
        [req.body.nome, req.body.nif, req.body.morada_faturacao, req.body.telefone, req.body.email_faturacao, req.params.id]);
        res.json({ mensagem: 'OK' });
    } catch (e) { res.status(500).send(e.message); }
});

app.put('/estabelecimentos/:id', async (req, res) => {
    try {
        await pool.query('UPDATE estabelecimentos SET cliente_id=?, nome_loja=?, codigo_apa=?, morada_local=? WHERE id=?', 
        [req.body.cliente_id, req.body.nome_loja, req.body.codigo_apa, req.body.morada_local, req.params.id]);
        res.json({ mensagem: 'OK' });
    } catch (e) { res.status(500).send(e.message); }
});

app.listen(porta, () => console.log(`🚀 Servidor a correr na porta ${porta}`));