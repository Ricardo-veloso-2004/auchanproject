const express = require('express');
const mysql = require('mysql2');

const app = express();
const porta = 3000;

// Permite ao servidor ler os dados enviados pelo formulário em formato JSON
app.use(express.json()); 
// Diz ao servidor para mostrar a tua página web que está na pasta "public"
app.use(express.static('public')); 

// Ligação à Base de Dados
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'gestao_reciclagem'
});

db.connect((erro) => {
    if (erro) return console.error('Erro ao ligar BD:', erro);
    console.log('✅ Ligação ao MySQL feita com sucesso!');
});

// ==========================================
// ROTAS DE CLIENTES (SEDES) E LOJAS
// ==========================================

// 1. Buscar todos os Clientes e Lojas (com todos os detalhes para o Modal)
app.get('/clientes', (req, res) => {
    const query = `
        SELECT c.nome AS Sede, c.nif, c.telefone, c.email_faturacao, c.morada_faturacao,
               e.nome_loja AS Loja, e.codigo_apa, e.morada_local AS morada_loja
        FROM estabelecimentos e
        JOIN clientes c ON e.cliente_id = c.id
        ORDER BY c.nome, e.nome_loja
    `;
    db.query(query, (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

// 2. Gravar um NOVO Cliente (Sede) com NIF, Morada, Email e Telefone
app.post('/clientes', (req, res) => {
    const { nome, nif, morada_faturacao, email_faturacao, telefone } = req.body; 
    
    const query = 'INSERT INTO clientes (nome, nif, morada_faturacao, email_faturacao, telefone) VALUES (?, ?, ?, ?, ?)';
    
    db.query(query, [nome, nif, morada_faturacao, email_faturacao, telefone], (erro, resultados) => {
        if (erro) {
            console.error(erro);
            return res.status(500).json({ erro: 'Erro ao inserir. NIF já existe?' });
        }
        res.status(201).json({ mensagem: 'Cliente criado com sucesso!' });
    });
});

// 3. Buscar apenas as Sedes (para preencher a lista Dropdown nas Lojas e na Faturação)
app.get('/sedes', (req, res) => {
    db.query('SELECT id, nome FROM clientes', (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

// 4. Gravar uma NOVA Loja (Estabelecimento) com Nome, Código APA e Morada
app.post('/estabelecimentos', (req, res) => {
    // AGORA RECEBE morada_local!
    const { cliente_id, nome_loja, codigo_apa, morada_local } = req.body; 
    
    // AGORA INSERE EM morada_local!
    const query = `INSERT INTO estabelecimentos (cliente_id, nome_loja, codigo_apa, morada_local) VALUES (?, ?, ?, ?)`;
    
    db.query(query, [cliente_id, nome_loja, codigo_apa, morada_local], (erro, resultados) => {
        if (erro) {
            console.error(erro);
            return res.status(500).json({ erro: 'Erro a inserir. O Código APA já existe?' });
        }
        res.status(201).json({ mensagem: 'Loja adicionada com sucesso!' });
    });
});

// ==========================================
// ROTAS DOS MATERIAIS E COTAÇÕES
// ==========================================

// 1. Buscar todos os materiais e o seu preço mais recente
app.get('/materiais', (req, res) => {
    const query = `
        SELECT m.id, m.codigo_ler, m.descricao, 
               (SELECT preco_tonelada 
                FROM cotacoes 
                WHERE material_id = m.id 
                ORDER BY data_inicio DESC, id DESC 
                LIMIT 1) AS preco_atual
        FROM materiais m
    `;
    db.query(query, (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

// 2. Adicionar um novo Material (Código LER)
app.post('/materiais', (req, res) => {
    const { codigo_ler, descricao } = req.body;
    db.query('INSERT INTO materiais (codigo_ler, descricao) VALUES (?, ?)', [codigo_ler, descricao], (erro, resultados) => {
        if (erro) return res.status(500).json({ erro: 'Erro ao inserir. Código LER já existe?' });
        res.status(201).json({ mensagem: 'Material criado!' });
    });
});

// 3. Adicionar uma nova Cotação (Preço) a um Material
app.post('/cotacoes', (req, res) => {
    const { material_id, preco_tonelada, data_inicio } = req.body;
    db.query('INSERT INTO cotacoes (material_id, preco_tonelada, data_inicio) VALUES (?, ?, ?)', 
    [material_id, preco_tonelada, data_inicio], (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.status(201).json({ mensagem: 'Cotação atualizada com sucesso!' });
    });
});

// ==========================================
// ROTAS DOS SERVIÇOS E AVENÇAS
// ==========================================

app.post('/servicos', (req, res) => {
    const { descricao, tipo } = req.body;
    db.query('INSERT INTO servicos (descricao, tipo) VALUES (?, ?)', [descricao, tipo], (erro) => {
        if (erro) return res.status(500).send(erro);
        res.status(201).json({ mensagem: 'Serviço adicionado ao catálogo!' });
    });
});

app.get('/servicos', (req, res) => {
    db.query('SELECT * FROM servicos', (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

app.get('/lojas', (req, res) => {
    const query = `
        SELECT e.id, e.nome_loja, c.nome AS sede_nome 
        FROM estabelecimentos e 
        JOIN clientes c ON e.cliente_id = c.id
        ORDER BY c.nome, e.nome_loja
    `;
    db.query(query, (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

app.post('/servicos-contratados', (req, res) => {
    const { estabelecimento_id, servico_id, valor, data_inicio } = req.body;
    db.query('INSERT INTO servicos_contratados (estabelecimento_id, servico_id, valor, data_inicio) VALUES (?, ?, ?, ?)',
    [estabelecimento_id, servico_id, valor, data_inicio], (erro) => {
        if (erro) return res.status(500).send(erro);
        res.status(201).json({ mensagem: 'Serviço associado à loja com sucesso!' });
    });
});

app.get('/servicos-contratados', (req, res) => {
    const query = `
        SELECT sc.id, e.nome_loja, s.descricao AS servico, s.tipo, sc.valor, sc.data_inicio
        FROM servicos_contratados sc
        JOIN estabelecimentos e ON sc.estabelecimento_id = e.id
        JOIN servicos s ON sc.servico_id = s.id
        ORDER BY e.nome_loja
    `;
    db.query(query, (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

// ==========================================
// ROTAS DAS GUIAS (e-GARs)
// ==========================================

app.post('/guias', (req, res) => {
    const { numero_guia, estabelecimento_id, material_id, peso_kg, estado, data_emissao } = req.body;
    
    const query = `INSERT INTO guias_siliamb (numero_guia, estabelecimento_id, material_id, peso_kg, estado, data_emissao) 
                   VALUES (?, ?, ?, ?, ?, ?)`;
                   
    db.query(query, [numero_guia, estabelecimento_id, material_id, peso_kg, estado, data_emissao], (erro) => {
        if (erro) {
            console.error(erro);
            return res.status(500).json({ erro: 'Erro a inserir guia. O número já existe?' });
        }
        res.status(201).json({ mensagem: 'Guia registada com sucesso!' });
    });
});

app.get('/guias', (req, res) => {
    const query = `
        SELECT g.id, g.numero_guia, e.nome_loja, m.descricao AS material, g.peso_kg, g.estado, g.data_emissao
        FROM guias_siliamb g
        JOIN estabelecimentos e ON g.estabelecimento_id = e.id
        JOIN materiais m ON g.material_id = m.id
        ORDER BY g.data_emissao DESC
    `;
    db.query(query, (erro, resultados) => {
        if (erro) return res.status(500).send(erro);
        res.json(resultados);
    });
});

// ==========================================
// ROTA DE FATURAÇÃO / RELATÓRIO MENSAL
// ==========================================

app.get('/faturacao/:cliente_id', (req, res) => {
    const cliente_id = req.params.cliente_id;

    const queryGuias = `
        SELECT e.nome_loja, m.descricao AS material, g.peso_kg, g.estado, g.numero_guia, g.data_emissao,
               (SELECT preco_tonelada FROM cotacoes WHERE material_id = g.material_id ORDER BY data_inicio DESC, id DESC LIMIT 1) AS preco_tonelada
        FROM guias_siliamb g
        JOIN estabelecimentos e ON g.estabelecimento_id = e.id
        JOIN materiais m ON g.material_id = m.id
        WHERE e.cliente_id = ?
        ORDER BY g.data_emissao DESC
    `;

    const queryServicos = `
        SELECT e.nome_loja, s.descricao AS servico, sc.valor, s.tipo
        FROM servicos_contratados sc
        JOIN estabelecimentos e ON sc.estabelecimento_id = e.id
        JOIN servicos s ON sc.servico_id = s.id
        WHERE e.cliente_id = ?
    `;

    db.query(queryGuias, [cliente_id], (err1, guias) => {
        if (err1) return res.status(500).send(err1);

        db.query(queryServicos, [cliente_id], (err2, servicos) => {
            if (err2) return res.status(500).send(err2);

            let totalResiduos = 0;
            guias.forEach(g => {
                const valor = (g.peso_kg / 1000) * (g.preco_tonelada || 0);
                g.valor_calculado = valor.toFixed(2);
                totalResiduos += valor;
            });

            let totalServicos = 0;
            servicos.forEach(s => {
                totalServicos += parseFloat(s.valor);
            });

            const balanco = totalResiduos - totalServicos;

            res.json({
                guias: guias,
                servicos: servicos,
                totais: {
                    residuos: totalResiduos.toFixed(2),
                    servicos: totalServicos.toFixed(2),
                    balanco: balanco.toFixed(2)
                }
            });
        });
    });
});

// ==========================================
// ROTA DO DASHBOARD (Estatísticas)
// ==========================================

app.get('/dashboard-stats', (req, res) => {
    const stats = {};

    db.query("SELECT COUNT(*) AS total FROM guias_siliamb WHERE estado = 'Emitida'", (err, resultados) => {
        if (err) return res.status(500).send(err);
        stats.guiasPendentes = resultados[0].total;

        db.query("SELECT COUNT(*) AS total FROM clientes", (err, resultados) => {
            if (err) return res.status(500).send(err);
            stats.totalClientes = resultados[0].total;

            db.query(`
                SELECT g.numero_guia, e.nome_loja, m.descricao AS material, g.peso_kg, g.data_emissao
                FROM guias_siliamb g
                JOIN estabelecimentos e ON g.estabelecimento_id = e.id
                JOIN materiais m ON g.material_id = m.id
                WHERE g.estado = 'Emitida'
                ORDER BY g.data_emissao DESC LIMIT 5
            `, (err, resultados) => {
                if (err) return res.status(500).send(err);
                stats.tabelaPendentes = resultados;

                db.query(`
                    SELECT m.descricao, SUM(g.peso_kg) AS total_peso
                    FROM guias_siliamb g
                    JOIN materiais m ON g.material_id = m.id
                    WHERE g.estado = 'Concluída'
                    GROUP BY m.descricao
                `, (err, resultados) => {
                    if (err) return res.status(500).send(err);
                    stats.graficoMateriais = resultados;

                    res.json(stats);
                });
            });
        });
    });
});

app.listen(porta, () => console.log(`🚀 Servidor a correr em http://localhost:${porta}`));