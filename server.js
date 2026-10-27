const express = require('express');
const app = express();
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

app.use(cors());
app.use(express.json({ limit: '1mb' })); // la foto de perfil viaja como data URL (ya reducida en el navegador)

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.use('/api', (req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CENTRAL_URL  = process.env.CENTRAL_API_URL;
const CENTRAL_KEY  = process.env.CENTRAL_API_KEY;
const BANK_CODE    = parseInt(process.env.CENTRAL_BANK_CODE);
const CENTRAL_ENV  = process.env.CENTRAL_ENV || 'test';
const ADMIN_USER   = process.env.ADMIN_USER   || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS   || 'admin123';
const SITUACION_MAXIMA_ALTA = 3; // situación crediticia máxima para abrir cuenta (4 y 5 se rechazan)
const nombresBancos = new Map(); // caché bankCode -> nombre

// Almacén de códigos de verificación en memoria
const codigosVerificacion = new Map(); // key: email, value: { codigo, expira, tipo }

// Tarjeta de débito virtual: una por persona y moneda (equivale a init/07_tarjetas_debito.sql)
const SQL_TARJETAS = `CREATE TABLE IF NOT EXISTS Tarjetas_Debito (
    id_persona INTEGER NOT NULL REFERENCES Personas(id) ON DELETE CASCADE,
    moneda VARCHAR(10) NOT NULL,
    numero VARCHAR(16) NOT NULL UNIQUE,
    vencimiento VARCHAR(5) NOT NULL,
    cvv VARCHAR(3) NOT NULL,
    PRIMARY KEY (id_persona, moneda)
)`;

// Número de 16 dígitos válido por Luhn. Arranca con 9 para no coincidir con ninguna red real (Visa, Mastercard, etc.)
function generarNumeroTarjeta() {
    const d = [9];
    for (let i = 1; i < 15; i++) d.push(crypto.randomInt(0, 10));
    let suma = 0;
    d.forEach((n, i) => { let x = n; if (i % 2 === 0) { x *= 2; if (x > 9) x -= 9; } suma += x; });
    d.push((10 - (suma % 10)) % 10);
    return d.join('');
}
function generarVencimiento() {
    const f = new Date(); f.setFullYear(f.getFullYear() + 4 + crypto.randomInt(0, 2));
    return String(f.getMonth() + 1).padStart(2, '0') + '/' + String(f.getFullYear()).slice(-2);
}
// Devuelve { ARS: {numero, vencimiento, cvv}, USD: {...} }; crea las que falten la primera vez
async function tarjetasDe(idPersona, monedas) {
    const out = {};
    const { rows } = await pool.query('SELECT moneda, numero, vencimiento, cvv FROM Tarjetas_Debito WHERE id_persona = $1', [idPersona]);
    rows.forEach(r => { out[r.moneda] = { numero: r.numero, vencimiento: r.vencimiento, cvv: r.cvv }; });
    for (const moneda of monedas) {
        if (out[moneda]) continue;
        for (let intento = 0; intento < 5; intento++) {
            const t = { numero: generarNumeroTarjeta(), vencimiento: generarVencimiento(), cvv: String(crypto.randomInt(0, 1000)).padStart(3, '0') };
            const r = await pool.query(
                'INSERT INTO Tarjetas_Debito (id_persona, moneda, numero, vencimiento, cvv) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
                [idPersona, moneda, t.numero, t.vencimiento, t.cvv]);
            if (r.rowCount) { out[moneda] = t; break; }
            const ya = await pool.query('SELECT numero, vencimiento, cvv FROM Tarjetas_Debito WHERE id_persona=$1 AND moneda=$2', [idPersona, moneda]);
            if (ya.rows.length) { out[moneda] = ya.rows[0]; break; } // otra petición la creó en paralelo
        }
    }
    return out;
}

pool.connect((err, client, release) => {
    if (err) return console.error('Error conectando a la base de datos:', err.message);
    console.log('Conectado a PostgreSQL correctamente');
    // Foto de perfil: se agrega la columna sola si todavía no existe (equivale a init/06_foto_perfil.sql)
    client.query('ALTER TABLE Personas ADD COLUMN IF NOT EXISTS foto TEXT')
        .then(() => client.query(SQL_TARJETAS))
        .catch(e => console.error('No se pudo preparar la columna foto:', e.message))
        .finally(() => release());
});

async function centralFetch(path, method = 'GET', body = null) {
    const fetch = (await import('node-fetch')).default;
    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': CENTRAL_KEY,
            'x-environment': CENTRAL_ENV
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${CENTRAL_URL}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function esCBUPropio(cbu) {
    const result = await pool.query('SELECT id_cuenta FROM Cuentas_Bancarias WHERE cbu = $1', [cbu]);
    return result.rows.length > 0;
}

async function nombreBanco(code) {
    if (nombresBancos.has(code)) return nombresBancos.get(code);
    try {
        const r = await centralFetch(`/banks/${code}`);
        if (r.status === 200 && r.data.name) {
            nombresBancos.set(code, r.data.name);
            return r.data.name;
        }
    } catch (_) { /* se usa el código como respaldo */ }
    return `Banco #${code}`;
}

function limpiarAlias(texto) {
    return String(texto).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
}

// Devuelve el alias que quedó asignado en el Central, o null si no se pudo
async function asignarAliasCentral(cbu, nombre, apellido, dni) {
    const base = `${limpiarAlias(nombre)}.${limpiarAlias(apellido)}`;
    const candidatos = [`${base}.boe`, `${base}.${dni.slice(-3)}.boe`, `${base}.${dni}.boe`];
    for (const alias of candidatos) {
        const r = await centralFetch(`/persons/${cbu}/alias`, 'PUT', { alias });
        if (r.status === 200) return alias;
        if (r.status !== 409) break; // solo se reintenta si el alias ya estaba en uso
    }
    return null;
}

function generarCodigo() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function enviarCodigo(email, tipo) {
    const codigo = generarCodigo();
    const expira = Date.now() + 10 * 60 * 1000; // 10 minutos
    codigosVerificacion.set(email, { codigo, expira, tipo });
    // OPCIÓN B: código simulado, se muestra en consola
    console.log(`\n🐍 CÓDIGO DE VERIFICACIÓN para ${email}: ${codigo} (expira en 10 min)\n`);
    return codigo;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ENVIAR CÓDIGO DE VERIFICACIÓN
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/verificacion/enviar', async (req, res) => {
    const { email, tipo } = req.body;
    if (!email || !tipo) return res.status(400).json({ error: 'Email y tipo requeridos' });

    // Para registro: verificar que el email no exista ya
    if (tipo === 'registro') {
        const existe = await pool.query('SELECT id FROM Personas WHERE email = $1', [email]);
        if (existe.rows.length > 0) return res.status(400).json({ error: 'El email ya está registrado' });
    }

    try {
        await enviarCodigo(email, tipo);
        res.json({ mensaje: `Código enviado a ${email}` });
    } catch (err) {
        console.error('Error al enviar email:', err.message);
        res.status(500).json({ error: 'No se pudo enviar el email. Verificá la configuración.' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — REGISTRO (con verificación de email)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/registro', async (req, res) => {
    const { nombre, apellido, dni, email, password, codigoVerificacion } = req.body;

    if (!nombre || !apellido || !dni || !email || !password || !codigoVerificacion) {
        return res.status(400).json({ error: "Faltan datos obligatorios" });
    }
    if (!/^\d{7,8}$/.test(String(dni))) return res.status(400).json({ error: "El DNI debe tener 7 u 8 dígitos" });

    // Verificar código
    const entry = codigosVerificacion.get(email);
    if (!entry) return res.status(400).json({ error: 'No se envió código a este email. Solicitá uno primero.' });
    if (Date.now() > entry.expira) { codigosVerificacion.delete(email); return res.status(400).json({ error: 'El código expiró. Solicitá uno nuevo.' }); }
    if (entry.codigo !== codigoVerificacion) return res.status(400).json({ error: 'Código de verificación incorrecto.' });
    codigosVerificacion.delete(email);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existe = await client.query('SELECT id FROM Personas WHERE dni = $1', [dni]);
        if (existe.rows.length > 0) return res.status(400).json({ error: "El DNI ya está registrado" });

        // Central de Deudores: se consulta antes de abrir la cuenta (404 = sin deudas informadas)
        const deudor = await centralFetch(`/central-deudores/${dni}`);
        if (deudor.status === 200 && deudor.data.situacion > SITUACION_MAXIMA_ALTA) {
            return res.status(403).json({ error: `No se puede abrir la cuenta: situación crediticia ${deudor.data.situacion} en la Central de Deudores` });
        }

        // Registrar en Banco Central
        const central = await centralFetch('/persons', 'POST', { nombre, apellido, dni });
        if (central.status !== 200 && central.status !== 201) {
            throw new Error('Error al registrar en Banco Central: ' + JSON.stringify(central.data));
        }
        const cbuOficial = central.data.cbu;
        const alias = await asignarAliasCentral(cbuOficial, nombre, apellido, String(dni));

        const hash = await bcrypt.hash(password, 10);

        const personaResult = await client.query(
            `INSERT INTO Personas (nombre, apellido, dni, email, password) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [nombre, apellido, dni, email, hash]
        );
        const idPersona = personaResult.rows[0].id;

        await client.query(`INSERT INTO Roles_x_Personas (id_persona, id_rol) VALUES ($1, 2)`, [idPersona]);

        const productoResult = await client.query(
            `INSERT INTO Productos (id_persona, id_tipo_producto, id_estado_producto) VALUES ($1, 1, 1) RETURNING id_producto`,
            [idPersona]
        );
        const idProducto = productoResult.rows[0].id_producto;

        await client.query(
            `INSERT INTO Cuentas_Bancarias (id_producto, cbu, alias, moneda, saldo) VALUES ($1, $2, $3, 'ARS', 0)`,
            [idProducto, cbuOficial, alias]
        );

        await client.query('COMMIT');
        res.status(201).json({ mensaje: "Usuario creado exitosamente", usuario: { id: idPersona, alias, cbu: cbuOficial } });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Error al crear el usuario: " + err.message });
    } finally {
        await client.query('ROLLBACK').catch(() => {}); // no-op si ya hubo COMMIT
        client.release();
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — LOGIN
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
    const { dni, password } = req.body;
    if (!dni || !password) return res.status(400).json({ error: "DNI y contraseña requeridos" });

    try {
        const result = await pool.query('SELECT * FROM Personas WHERE dni = $1', [dni]);
        if (result.rows.length === 0) return res.status(401).json({ error: "DNI no registrado" });

        const persona = result.rows[0];
        if (!persona.password) return res.status(401).json({ error: "Esta cuenta no tiene contraseña configurada" });

        const ok = await bcrypt.compare(password, persona.password);
        if (!ok) return res.status(401).json({ error: "Contraseña incorrecta" });

        res.json({ mensaje: "Login exitoso", usuario: { id: persona.id, nombre: persona.nombre, apellido: persona.apellido, email: persona.email } });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al iniciar sesión" });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — LOGIN ADMIN
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    if (usuario === ADMIN_USER && password === ADMIN_PASS) {
        res.json({ mensaje: "Login admin exitoso", admin: true });
    } else {
        res.status(401).json({ error: "Credenciales de administrador incorrectas" });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PANEL: todos los usuarios con saldo
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/usuarios', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.id, p.nombre, p.apellido, p.dni, p.email,
                   cb.alias, cb.cbu, cb.saldo, cb.moneda,
                   ep.nombre AS estado
            FROM Personas p
            JOIN Productos pr ON pr.id_persona = p.id
            JOIN Cuentas_Bancarias cb ON cb.id_producto = pr.id_producto
            JOIN Estados_Producto ep ON ep.id_estado_producto = pr.id_estado_producto
            ORDER BY p.id
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — ELIMINAR USUARIO
// ═══════════════════════════════════════════════════════════════════════════════
app.delete('/api/admin/usuarios/:id', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const cuentaResult = await client.query(`
            SELECT cb.id_cuenta, cb.cbu FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1
        `, [idPersona]);

        if (cuentaResult.rows.length === 0)
            return res.status(404).json({ error: "Usuario no encontrado" });

        // Puede tener más de una caja (ARS + USD): se borran todas
        for (const { id_cuenta } of cuentaResult.rows) {
            await client.query('DELETE FROM Movimientos WHERE id_cuenta = $1', [id_cuenta]);
            await client.query('DELETE FROM Cuentas_Bancarias WHERE id_cuenta = $1', [id_cuenta]);
        }
        await client.query('DELETE FROM Productos WHERE id_persona = $1', [idPersona]);
        await client.query('DELETE FROM Roles_x_Personas WHERE id_persona = $1', [idPersona]);
        await client.query('DELETE FROM Personas WHERE id = $1', [idPersona]);

        await client.query('COMMIT');
        res.json({ mensaje: "Usuario eliminado correctamente" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Error al eliminar usuario: " + err.message });
    } finally {
        await client.query('ROLLBACK').catch(() => {}); // no-op si ya hubo COMMIT
        client.release();
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN — PANEL: todos los movimientos
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/movimientos', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT m.id_movimiento, m.tipo, m.monto, m.detalle, m.descripcion, m.fecha,
                   p.nombre, p.apellido, p.dni, cb.alias
            FROM Movimientos m
            JOIN Cuentas_Bancarias cb ON cb.id_cuenta = m.id_cuenta
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            JOIN Personas p ON p.id = pr.id_persona
            ORDER BY m.fecha DESC
            LIMIT 200
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// VER ESTADO DE CUENTA
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/usuarios/:id', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    try {
        // La cuenta ARS es siempre la "principal" que se muestra arriba de todo
        const result = await pool.query(`
            SELECT p.id, p.nombre, p.apellido, p.email, p.foto,
                   cb.alias, cb.cbu, cb.saldo, cb.moneda, cb.id_cuenta
            FROM Personas p
            JOIN Productos pr ON pr.id_persona = p.id
            JOIN Cuentas_Bancarias cb ON cb.id_producto = pr.id_producto
            WHERE p.id = $1 AND cb.moneda = 'ARS' LIMIT 1
        `, [idPersona]);

        if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
        const usuario = result.rows[0];

        // Todas las cajas de la persona (ARS siempre existe; USD es opcional)
        const cuentasResult = await pool.query(`
            SELECT cb.moneda, cb.saldo, cb.alias, cb.cbu FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 ORDER BY cb.moneda
        `, [idPersona]);

        // Historial combinado de todas las cajas, con la moneda de cada movimiento
        const historialResult = await pool.query(`
            SELECT m.id_movimiento, m.tipo, m.monto, m.detalle, m.descripcion, m.fecha, cb.moneda
            FROM Movimientos m
            JOIN Cuentas_Bancarias cb ON cb.id_cuenta = m.id_cuenta
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1
            ORDER BY m.fecha DESC LIMIT 30
        `, [idPersona]);

        const tarjetas = await tarjetasDe(idPersona, cuentasResult.rows.map(c => c.moneda));

        res.json({
            id: usuario.id,
            tarjetas,
            nombre: `${usuario.nombre} ${usuario.apellido}`,
            email: usuario.email,
            foto: usuario.foto || null,
            alias: usuario.alias,
            cbu: usuario.cbu,
            saldo: parseFloat(usuario.saldo),
            moneda: usuario.moneda,
            historial: historialResult.rows,
            cuentas: cuentasResult.rows.map(c => ({ ...c, saldo: parseFloat(c.saldo) }))
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al obtener el usuario" });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// FOTO DE PERFIL
// ═══════════════════════════════════════════════════════════════════════════════
const FOTO_REGEX = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;
const FOTO_MAX_CHARS = 400000; // ~300 KB de imagen

app.put('/api/usuarios/:id/foto', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const { foto } = req.body;
    if (typeof foto !== 'string' || !FOTO_REGEX.test(foto)) return res.status(400).json({ error: 'Imagen inválida. Usá PNG, JPG o WEBP.' });
    if (foto.length > FOTO_MAX_CHARS) return res.status(413).json({ error: 'La imagen es demasiado pesada.' });
    try {
        const r = await pool.query('UPDATE Personas SET foto = $1 WHERE id = $2', [foto, idPersona]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ mensaje: 'Foto actualizada' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo guardar la foto' });
    }
});

app.delete('/api/usuarios/:id/foto', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    try {
        const r = await pool.query('UPDATE Personas SET foto = NULL WHERE id = $1', [idPersona]);
        if (r.rowCount === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        res.json({ mensaje: 'Foto eliminada' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudo eliminar la foto' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// INGRESAR DINERO
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/:id/ingresar', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const { monto, descripcion } = req.body;
    const moneda = req.body.moneda === 'USD' ? 'USD' : 'ARS';
    if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const cuentaResult = await client.query(`
            SELECT cb.id_cuenta, cb.saldo FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 AND cb.moneda = $2 LIMIT 1
        `, [idPersona, moneda]);

        if (cuentaResult.rows.length === 0)
            return res.status(404).json({ error: moneda === 'USD' ? "Todavía no abriste tu caja en USD" : "Cuenta no encontrada" });
        const cuenta = cuentaResult.rows[0];

        await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo + $1 WHERE id_cuenta = $2`, [monto, cuenta.id_cuenta]);
        await client.query(
            `INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Ingreso de efectivo', $2, 'Carga por cajero o transferencia', $3) RETURNING id_movimiento`,
            [cuenta.id_cuenta, monto, descripcion || null]
        );

        await client.query('COMMIT');
        res.json({ mensaje: "Dinero acreditado", saldoActual: parseFloat(cuenta.saldo) + monto });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Error al ingresar dinero" });
    } finally {
        await client.query('ROLLBACK').catch(() => {}); // no-op si ya hubo COMMIT
        client.release();
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// TRANSFERIR
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/transferencia', async (req, res) => {
    const { emisorId, aliasDestino, monto, descripcion } = req.body;
    let { cbuDestino } = req.body;
    const moneda = req.body.moneda === 'USD' ? 'USD' : 'ARS';
    if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });
    if (!aliasDestino && !cbuDestino) return res.status(400).json({ error: "Indicá alias o CBU destino" });
    if (cbuDestino && !/^\d{22}$/.test(cbuDestino)) return res.status(400).json({ error: "El CBU debe tener 22 dígitos" });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const emisorResult = await client.query(`
            SELECT cb.id_cuenta, cb.saldo, cb.cbu, p.nombre, p.apellido
            FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            JOIN Personas p ON p.id = pr.id_persona
            WHERE pr.id_persona = $1 AND cb.moneda = $2 LIMIT 1
            FOR UPDATE OF cb
        `, [emisorId, moneda]);

        if (emisorResult.rows.length === 0)
            return res.status(404).json({ error: moneda === 'USD' ? "Todavía no abriste tu caja en USD" : "Emisor no encontrado" });
        const emisor = emisorResult.rows[0];
        if (parseFloat(emisor.saldo) < monto) return res.status(400).json({ error: "Saldo insuficiente" });

        const desc = descripcion || null;

        if (!aliasDestino && cbuDestino === emisor.cbu) return res.status(400).json({ error: "No podés transferirte a tu misma cuenta" });

        // Si el destino se resuelve contra el Banco Central (alias de otro banco o CBU directo),
        // acá se guarda su moneda para validar que coincida con la de origen antes de mover nada.
        let destMonedaCentral = null;

        let aliasLocal = !!aliasDestino;
        if (aliasDestino) {
            const local = await client.query('SELECT id_cuenta, moneda FROM Cuentas_Bancarias WHERE alias = $1', [aliasDestino]);
            if (local.rows.length > 0 && local.rows[0].id_cuenta === emisor.id_cuenta)
                return res.status(400).json({ error: "No podés transferirte a tu misma cuenta" });
            if (local.rows.length === 0) {
                // Alias de otro banco: se resuelve en el Banco Central y sigue como interbancaria
                const resuelto = await centralFetch(`/accounts/alias/${encodeURIComponent(aliasDestino)}`);
                if (resuelto.status !== 200 || !resuelto.data.cbu) return res.status(404).json({ error: "Alias no encontrado" });
                cbuDestino = resuelto.data.cbu;
                destMonedaCentral = resuelto.data.moneda || 'ARS';
                aliasLocal = false;
            } else if (local.rows[0].moneda !== moneda) {
                return res.status(400).json({ error: `Ese alias es una cuenta en ${local.rows[0].moneda}, no podés transferirle en ${moneda}` });
            }
        }

        if (aliasLocal) {
            const receptorResult = await client.query(`
                SELECT cb.id_cuenta, cb.saldo, p.nombre, p.apellido
                FROM Cuentas_Bancarias cb
                JOIN Productos pr ON pr.id_producto = cb.id_producto
                JOIN Personas p ON p.id = pr.id_persona
                WHERE cb.alias = $1 AND cb.moneda = $2 LIMIT 1
            `, [aliasDestino, moneda]);

            if (receptorResult.rows.length === 0) return res.status(404).json({ error: "Alias no existe en este banco" });
            const receptor = receptorResult.rows[0];

            await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo - $1 WHERE id_cuenta = $2`, [monto, emisor.id_cuenta]);
            await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo + $1 WHERE id_cuenta = $2`, [monto, receptor.id_cuenta]);
            const r1 = await client.query(`INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Transferencia enviada', $2, $3, $4) RETURNING id_movimiento`, [emisor.id_cuenta, -monto, `Enviado a ${receptor.nombre} ${receptor.apellido}`, desc]);
            await client.query(`INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Transferencia recibida', $2, $3, $4)`, [receptor.id_cuenta, monto, `Recibido de ${emisor.nombre} ${emisor.apellido}`, desc]);

            await client.query('COMMIT');
            return res.json({
                mensaje: "Transferencia local exitosa",
                saldoRestante: parseFloat(emisor.saldo) - monto,
                comprobante: {
                    id: r1.rows[0].id_movimiento,
                    tipo: 'Transferencia enviada',
                    emisor: `${emisor.nombre} ${emisor.apellido}`,
                    receptor: `${receptor.nombre} ${receptor.apellido}`,
                    alias: aliasDestino,
                    monto,
                    moneda,
                    descripcion: desc,
                    fecha: new Date().toISOString()
                }
            });
        }

        const esPropio = await esCBUPropio(cbuDestino);
        if (esPropio) {
            const receptorResult = await client.query(`
                SELECT cb.id_cuenta, cb.saldo, cb.moneda, p.nombre, p.apellido
                FROM Cuentas_Bancarias cb
                JOIN Productos pr ON pr.id_producto = cb.id_producto
                JOIN Personas p ON p.id = pr.id_persona
                WHERE cb.cbu = $1 LIMIT 1
            `, [cbuDestino]);

            if (receptorResult.rows.length === 0) return res.status(404).json({ error: "CBU no encontrado" });
            const receptor = receptorResult.rows[0];
            if (receptor.moneda !== moneda)
                return res.status(400).json({ error: `Ese CBU es una cuenta en ${receptor.moneda}, no podés transferirle en ${moneda}` });

            await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo - $1 WHERE id_cuenta = $2`, [monto, emisor.id_cuenta]);
            await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo + $1 WHERE id_cuenta = $2`, [monto, receptor.id_cuenta]);
            const r2 = await client.query(`INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Transferencia enviada', $2, $3, $4) RETURNING id_movimiento`, [emisor.id_cuenta, -monto, `Enviado a ${receptor.nombre} ${receptor.apellido} (CBU)`, desc]);
            await client.query(`INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Transferencia recibida', $2, $3, $4)`, [receptor.id_cuenta, monto, `Recibido de ${emisor.nombre} ${emisor.apellido} (CBU)`, desc]);

            await client.query('COMMIT');
            return res.json({
                mensaje: "Transferencia local exitosa",
                saldoRestante: parseFloat(emisor.saldo) - monto,
                comprobante: {
                    id: r2.rows[0].id_movimiento,
                    tipo: 'Transferencia enviada',
                    emisor: `${emisor.nombre} ${emisor.apellido}`,
                    receptor: `${receptor.nombre} ${receptor.apellido}`,
                    cbu: cbuDestino,
                    monto,
                    moneda,
                    descripcion: desc,
                    fecha: new Date().toISOString()
                }
            });
        }

        // Interbancaria: si el destino no se resolvió por alias, falta confirmar su moneda
        if (destMonedaCentral === null) {
            const destLookup = await centralFetch(`/accounts/${cbuDestino}`);
            if (destLookup.status !== 200) return res.status(404).json({ error: 'CBU destino no encontrado en el Banco Central' });
            destMonedaCentral = destLookup.data.moneda || 'ARS';
        }
        if (destMonedaCentral !== moneda)
            return res.status(400).json({ error: `Esa cuenta destino es en ${destMonedaCentral}, no podés transferirle en ${moneda}` });

        const centralRes = await centralFetch('/transactions', 'POST', {
            cbuOrigen: emisor.cbu, cbuDestino, importe: monto, saldoOrigen: parseFloat(emisor.saldo)
        });

        if (centralRes.status !== 201) {
            await client.query('ROLLBACK');
            return res.status(centralRes.status).json({ error: centralRes.data.error || 'El Banco Central rechazó la transferencia' });
        }

        let comprobanteId = null;
        if (centralRes.data.estado === 'aprobada') {
            await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo - $1 WHERE id_cuenta = $2`, [monto, emisor.id_cuenta]);
            const r3 = await client.query(`INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion, id_central) VALUES ($1, 'Transferencia interbancaria enviada', $2, $3, $4, $5) RETURNING id_movimiento`,
                [emisor.id_cuenta, -monto, `Enviado a ${centralRes.data.nombreDestino || cbuDestino} [interbancaria]`, desc, centralRes.data.transaccionId || null]);
            comprobanteId = r3.rows[0].id_movimiento;
        }

        await client.query('COMMIT');
        return res.json({
            mensaje: `Transferencia interbancaria ${centralRes.data.estado}`,
            estado: centralRes.data.estado,
            saldoRestante: parseFloat(emisor.saldo) - monto,
            comprobante: {
                id: comprobanteId,
                tipo: 'Transferencia interbancaria',
                emisor: `${emisor.nombre} ${emisor.apellido}`,
                receptor: centralRes.data.nombreDestino || null,
                cbu: cbuDestino,
                monto,
                moneda,
                descripcion: desc,
                fecha: new Date().toISOString()
            }
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Error al transferir: " + err.message });
    } finally {
        await client.query('ROLLBACK').catch(() => {}); // no-op si ya hubo COMMIT
        client.release();
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// PAGAR SERVICIO
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/:id/pagar', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const { servicio, monto, descripcion } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const cuentaResult = await client.query(`
            SELECT cb.id_cuenta, cb.saldo FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 AND cb.moneda = 'ARS' LIMIT 1
        `, [idPersona]);

        if (cuentaResult.rows.length === 0) return res.status(404).json({ error: "Cuenta no encontrada" });
        const cuenta = cuentaResult.rows[0];
        if (parseFloat(cuenta.saldo) < monto) return res.status(400).json({ error: "Saldo insuficiente" });

        await client.query(`UPDATE Cuentas_Bancarias SET saldo = saldo - $1 WHERE id_cuenta = $2`, [monto, cuenta.id_cuenta]);
        const r = await client.query(
            `INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, descripcion) VALUES ($1, 'Pago de Servicio', $2, $3, $4) RETURNING id_movimiento`,
            [cuenta.id_cuenta, -monto, servicio, descripcion || null]
        );

        await client.query('COMMIT');
        res.json({
            mensaje: `Pago de ${servicio} realizado`,
            saldoActual: parseFloat(cuenta.saldo) - monto,
            comprobante: {
                id: r.rows[0].id_movimiento,
                tipo: 'Pago de Servicio',
                servicio,
                monto,
                descripcion: descripcion || null,
                fecha: new Date().toISOString()
            }
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: "Error al pagar" });
    } finally {
        await client.query('ROLLBACK').catch(() => {}); // no-op si ya hubo COMMIT
        client.release();
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// CAMBIAR CONTRASEÑA (con verificación de email)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/:id/cambiar-password', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const { passwordActual, passwordNueva, codigoVerificacion } = req.body;

    if (!passwordActual || !passwordNueva || !codigoVerificacion)
        return res.status(400).json({ error: "Faltan datos" });
    if (passwordNueva.length < 6)
        return res.status(400).json({ error: "La nueva contraseña debe tener al menos 6 caracteres" });

    try {
        const result = await pool.query('SELECT password, email FROM Personas WHERE id = $1', [idPersona]);
        if (result.rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

        const { password: hash, email } = result.rows[0];

        const ok = await bcrypt.compare(passwordActual, hash);
        if (!ok) return res.status(401).json({ error: "La contraseña actual es incorrecta" });

        // Verificar código
        const entry = codigosVerificacion.get(email);
        if (!entry) return res.status(400).json({ error: 'Código no enviado. Solicitá uno primero.' });
        if (Date.now() > entry.expira) { codigosVerificacion.delete(email); return res.status(400).json({ error: 'El código expiró.' }); }
        if (entry.codigo !== codigoVerificacion) return res.status(400).json({ error: 'Código incorrecto.' });
        codigosVerificacion.delete(email);

        const nuevoHash = await bcrypt.hash(passwordNueva, 10);
        await pool.query('UPDATE Personas SET password = $1 WHERE id = $2', [nuevoHash, idPersona]);

        res.json({ mensaje: "Contraseña actualizada correctamente" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al cambiar la contraseña" });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BANCO CENTRAL
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/bancos', async (req, res) => {
    try {
        const { data } = await centralFetch('/banks');
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/transacciones-central', async (req, res) => {
    try {
        const minutos = req.query.minutos || 1440;
        const { data } = await centralFetch(`/transactions?minutos=${minutos}`);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// BANCO CENTRAL — consultas y gestión
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/bancos/:codigo', async (req, res) => {
    try {
        const { status, data } = await centralFetch(`/banks/${parseInt(req.params.codigo)}`);
        res.status(status).json(status === 200 ? data : { error: data.error || 'Banco no encontrado' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Datos del destinatario (para confirmar nombre antes de transferir): ?cbu=... o ?alias=...
app.get('/api/destinatario', async (req, res) => {
    const { cbu, alias } = req.query;
    if (!cbu && !alias) return res.status(400).json({ error: 'Indicá cbu o alias' });
    try {
        const path = cbu ? `/accounts/${encodeURIComponent(cbu)}` : `/accounts/alias/${encodeURIComponent(alias)}`;
        const { status, data } = await centralFetch(path);
        if (status !== 200) return res.status(status).json({ error: data.error || 'Destinatario no encontrado' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cambiar alias: primero el Central (único global), después la base local
app.put('/api/usuarios/:id/alias', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const { alias } = req.body;
    const moneda = req.body.moneda === 'USD' ? 'USD' : 'ARS';
    if (!alias || alias.length > 50 || !/^[A-Za-z0-9.-]+$/.test(alias))
        return res.status(400).json({ error: 'Alias inválido: solo letras, números, puntos y guiones (máx. 50)' });

    try {
        const cuenta = await pool.query(`
            SELECT cb.id_cuenta, cb.cbu FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 AND cb.moneda = $2 LIMIT 1
        `, [idPersona, moneda]);
        if (cuenta.rows.length === 0)
            return res.status(404).json({ error: moneda === 'USD' ? 'Todavía no abriste tu caja en USD' : 'Cuenta no encontrada' });

        const { id_cuenta, cbu } = cuenta.rows[0];
        const central = await centralFetch(`/accounts/${cbu}/alias`, 'PUT', { alias });
        if (central.status === 409) return res.status(409).json({ error: 'Ese alias ya está en uso' });
        if (central.status !== 200) return res.status(central.status).json({ error: central.data.error || 'El Banco Central rechazó el alias' });

        await pool.query('UPDATE Cuentas_Bancarias SET alias = $1 WHERE id_cuenta = $2', [alias, id_cuenta]);
        res.json({ mensaje: 'Alias actualizado', alias });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al cambiar el alias' });
    }
});

// Datos actuales del propio banco (para prellenar el nombre al renombrarlo)
app.get('/api/admin/banco', async (req, res) => {
    try {
        const { status, data } = await centralFetch(`/banks/${BANK_CODE}`);
        res.status(status).json(status === 200 ? data : { error: data.error || 'No se pudo obtener el banco' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Cambiar el nombre del banco en el Central
app.put('/api/admin/banco', async (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nombre requerido' });
    try {
        const { status, data } = await centralFetch('/banks/me', 'PUT', { name });
        if (status === 409) return res.status(409).json({ error: 'Ese nombre ya está en uso' });
        if (status !== 200) return res.status(status).json({ error: data.error || 'El Banco Central rechazó el cambio' });
        res.json({ mensaje: 'Nombre actualizado', name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// ABRIR CAJA EN USD
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/:id/cuentas-usd', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const persona = await client.query('SELECT dni FROM Personas WHERE id = $1', [idPersona]);
        if (persona.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        const { dni } = persona.rows[0];

        const existente = await client.query(`
            SELECT cb.cbu FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 AND cb.moneda = 'USD' LIMIT 1
        `, [idPersona]);
        if (existente.rows.length > 0) return res.status(400).json({ error: 'Ya tenés una caja de ahorro en USD' });

        const central = await centralFetch('/accounts', 'POST', { dni, moneda: 'USD' });
        if (central.status !== 200 && central.status !== 201)
            return res.status(central.status).json({ error: central.data.error || 'El Banco Central rechazó la apertura' });

        const productoResult = await client.query(
            `INSERT INTO Productos (id_persona, id_tipo_producto, id_estado_producto) VALUES ($1, 1, 1) RETURNING id_producto`,
            [idPersona]
        );
        await client.query(
            `INSERT INTO Cuentas_Bancarias (id_producto, cbu, alias, moneda, saldo) VALUES ($1, $2, $3, 'USD', 0)`,
            [productoResult.rows[0].id_producto, central.data.cbu, central.data.alias || null]
        );

        await client.query('COMMIT');
        res.status(201).json({ mensaje: 'Caja en USD creada', cbu: central.data.cbu, alias: central.data.alias || null });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Error al abrir la caja en USD: ' + err.message });
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// CENTRAL DE DEUDORES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/deudores/:dni', async (req, res) => {
    try {
        const { status, data } = await centralFetch(`/central-deudores/${encodeURIComponent(req.params.dni)}`);
        res.status(status).json(status === 200 ? data : { error: data.error || 'El DNI no figura en la central de deudores' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/deudores', async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT d.id_deuda, d.monto, d.situacion, d.fecha_informe, p.nombre, p.apellido, p.dni
            FROM Deudas_Informadas d
            JOIN Personas p ON p.id = d.id_persona
            ORDER BY d.fecha_informe DESC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Informar (o actualizar) la deuda de un cliente del banco
app.post('/api/admin/deudores', async (req, res) => {
    const dni = String(req.body.dni || '');
    const monto = Number(req.body.monto);
    const situacion = Number(req.body.situacion);
    if (!/^\d{7,8}$/.test(dni) || !(monto >= 0) || !Number.isInteger(situacion) || situacion < 1 || situacion > 5)
        return res.status(400).json({ error: 'DNI (7-8 dígitos), monto (>= 0) y situación (1 a 5) son obligatorios' });

    try {
        const persona = await pool.query('SELECT id FROM Personas WHERE dni = $1', [dni]);
        if (persona.rows.length === 0) return res.status(404).json({ error: 'El DNI no es cliente de este banco' });

        const central = await centralFetch('/central-deudores', 'POST', { dni, monto, situacion });
        if (central.status !== 200 && central.status !== 201)
            return res.status(central.status).json({ error: central.data.error || 'El Banco Central rechazó el informe' });

        await pool.query(`
            INSERT INTO Deudas_Informadas (id_persona, monto, situacion) VALUES ($1, $2, $3)
            ON CONFLICT (id_persona) DO UPDATE
            SET monto = EXCLUDED.monto, situacion = EXCLUDED.situacion, fecha_informe = CURRENT_TIMESTAMP
        `, [persona.rows[0].id, monto, situacion]);

        res.status(central.status).json(central.data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error al informar la deuda' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// TABLAS (debug)
// ═══════════════════════════════════════════════════════════════════════════════
const TABLAS_PERMITIDAS = ['personas','roles','roles_x_personas','tipos_producto','estados_producto','productos','cuentas_bancarias','tarjetas_credito','movimientos'];
app.get('/api/tablas/:tabla', async (req, res) => {
    const tabla = req.params.tabla.toLowerCase();
    if (!TABLAS_PERMITIDAS.includes(tabla)) return res.status(404).json({ error: `Tabla '${tabla}' no encontrada` });
    try {
        const { rows } = await pool.query(`SELECT * FROM ${tabla}`);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// POLLING
// ═══════════════════════════════════════════════════════════════════════════════
let pollingEnCurso = false;

async function procesarTransferenciasRecibidas() {
    if (pollingEnCurso) return; // evita corridas superpuestas
    pollingEnCurso = true;
    try {
        // Ventana de 30 min: se solapa a propósito; id_central (UNIQUE) evita acreditar dos veces
        const { data: txs } = await centralFetch('/transactions?minutos=30');
        if (!Array.isArray(txs)) return;

        for (const tx of txs) {
            if (tx.estado !== 'aprobada' || tx.bankCodeDestino !== BANK_CODE) continue;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const cuenta = await client.query('SELECT id_cuenta FROM Cuentas_Bancarias WHERE cbu = $1', [tx.cbuDestino]);
                if (cuenta.rows.length === 0) { await client.query('ROLLBACK'); continue; }
                const idCuenta = cuenta.rows[0].id_cuenta;

                const origen = tx.personaOrigen;
                const quien = origen ? `${origen.nombre} ${origen.apellido}` : tx.cbuOrigen;
                const banco = await nombreBanco(tx.bankCodeOrigen);

                const ins = await client.query(
                    `INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle, id_central)
                     VALUES ($1, 'Transferencia interbancaria recibida', $2, $3, $4)
                     ON CONFLICT (id_central) DO NOTHING RETURNING id_movimiento`,
                    [idCuenta, tx.importe, `Recibido de ${quien} - ${banco}`, tx._id]
                );

                if (ins.rows.length > 0) { // solo acredita si el movimiento es nuevo
                    await client.query('UPDATE Cuentas_Bancarias SET saldo = saldo + $1 WHERE id_cuenta = $2', [tx.importe, idCuenta]);
                    console.log(`✓ Interbancaria recibida: $${tx.importe} de ${quien} (${banco})`);
                }

                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                console.error(`Error acreditando ${tx._id}:`, err.message);
            } finally {
                client.release();
            }
        }
    } catch (err) {
        console.error('Error en polling:', err.message);
    } finally {
        pollingEnCurso = false;
    }
}

setInterval(procesarTransferenciasRecibidas, 30000);

// ═══════════════════════════════════════════════════════════════════════════════
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`--- Servidor Banco La Cobra ---`);
    console.log(`Corriendo en http://localhost:${PORT}`);
    // Direcciones para abrirlo desde el celular (misma red Wi-Fi). Se muestra el nombre del adaptador para distinguir cuál es cuál.
    const virtual = /vethernet|wsl|virtualbox|vmware|vbox|hyper-v|docker|loopback|tailscale|zerotier|vpn|tap|tun/i;
    Object.entries(require('os').networkInterfaces()).forEach(([nombre, lista]) => {
        (lista || []).filter(i => i.family === 'IPv4' && !i.internal).forEach(i => {
            const nota = virtual.test(nombre) ? '  (adaptador virtual, probablemente NO es esta)' : (/wi-?fi|wlan|inal/i.test(nombre) ? '  <-- Wi-Fi, usá esta' : '');
            console.log(`Celular: http://${i.address}:${PORT}   [${nombre}]${nota}`);
        });
    });
    console.log(`Banco Central: ${CENTRAL_ENV} | bankCode: ${BANK_CODE}`);
    setTimeout(procesarTransferenciasRecibidas, 3000);
});