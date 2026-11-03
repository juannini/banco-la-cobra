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
const codigosVerificacion = new Map(); // key: email (minúsculas), value: { hash, salt, expira, tipo, intentos, enviadoEn }

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
        .then(() => client.query(SQL_RENDIMIENTOS))
        .then(() => setTimeout(devengarRendimientos, 2000))
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

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICACIÓN POR CORREO (códigos de 6 dígitos enviados con Resend — https://resend.com)
// ═══════════════════════════════════════════════════════════════════════════════
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_URL = process.env.RESEND_URL || 'https://api.resend.com/emails';
// Con el remitente de prueba (onboarding@resend.dev) Resend solo entrega al correo dueño de la cuenta.
// Para enviar a correos reales hay que verificar un dominio propio y usar un remitente de ese dominio.
const MAIL_FROM = process.env.MAIL_FROM || 'Banco La Cobra <onboarding@resend.dev>';

const enteroEnRango = (v, porDefecto, min, max) => { const n = parseInt(v); return Number.isInteger(n) && n >= min && n <= max ? n : porDefecto; };
const CODIGO_TTL_MIN           = enteroEnRango(process.env.CODIGO_TTL_MIN, 10, 1, 60);          // vencimiento
const CODIGO_MAX_INTENTOS      = enteroEnRango(process.env.CODIGO_MAX_INTENTOS, 5, 1, 10);      // intentos fallidos por código
const CODIGO_REENVIO_SEG       = enteroEnRango(process.env.CODIGO_REENVIO_SEG, 60, 10, 600);    // espera mínima entre envíos
const CODIGO_MAX_ENVIOS_HORA   = enteroEnRango(process.env.CODIGO_MAX_ENVIOS_HORA, 5, 1, 50);   // envíos por email por hora
const CODIGO_MAX_ENVIOS_IP_HORA = enteroEnRango(process.env.CODIGO_MAX_ENVIOS_IP_HORA, 15, 1, 200); // envíos por IP por hora
const TIPOS_CODIGO = new Set(['registro', 'password']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

if (RESEND_API_KEY) console.log(`✉  Resend configurado. Remitente: ${MAIL_FROM}`);
else console.warn('⚠  RESEND_API_KEY no configurada: los códigos NO se envían por correo, se imprimen en esta consola (solo desarrollo).');

const enviosPorEmail = new Map(); // email -> [timestamps de envíos de la última hora]
const enviosPorIp = new Map();    // ip    -> [timestamps de envíos de la última hora]

class ErrorVerificacion extends Error {
    constructor(status, mensaje, extra = {}) { super(mensaje); this.status = status; this.extra = extra; }
}
const responderErrorVerificacion = (res, err) => res.status(err.status).json({ error: err.message, ...err.extra });

function normalizarEmail(valor) {
    const e = String(valor ?? '').trim().toLowerCase();
    return e.length <= 254 && EMAIL_REGEX.test(e) ? e : null;
}

// 6 dígitos con generador criptográfico (puede empezar con 0)
function generarCodigo() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
const hashCodigo = (codigo, salt) => crypto.createHash('sha256').update(salt + codigo).digest();

function enviosRecientes(mapa, clave, ahora) {
    const lista = (mapa.get(clave) || []).filter(t => ahora - t < 3600 * 1000);
    mapa.set(clave, lista);
    return lista;
}

function plantillaCodigo(codigo, tipo) {
    const accion = tipo === 'registro' ? 'crear tu cuenta' : 'cambiar tu contraseña';
    const asunto = tipo === 'registro' ? 'Tu código para crear tu cuenta en Banco La Cobra' : 'Tu código para cambiar tu contraseña en Banco La Cobra';
    const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1c1a15">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:14px;border:1px solid #e3dccb">
<tr><td style="padding:26px 28px 6px;font-size:20px;font-weight:700;letter-spacing:2px;color:#8a6a1e">🐍 BANCO LA COBRA</td></tr>
<tr><td style="padding:8px 28px 0;font-size:15px;line-height:1.5">Usá este código para ${accion}:</td></tr>
<tr><td align="center" style="padding:18px 28px"><div style="display:inline-block;padding:14px 26px;border-radius:10px;background:#f4f1ea;font-family:'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#1c1a15">${codigo}</div></td></tr>
<tr><td style="padding:0 28px 6px;font-size:13px;line-height:1.5;color:#6a665b">El código vence en ${CODIGO_TTL_MIN} minutos y se puede usar una sola vez.</td></tr>
<tr><td style="padding:0 28px 26px;font-size:13px;line-height:1.5;color:#6a665b">Si no lo pediste vos, ignorá este mensaje: nadie puede entrar a tu cuenta sin el código. El banco nunca te va a pedir este código por teléfono ni por chat.</td></tr>
</table></td></tr></table></body></html>`;
    const text = `Banco La Cobra\n\nUsá este código para ${accion}: ${codigo}\n\nVence en ${CODIGO_TTL_MIN} minutos y se puede usar una sola vez.\nSi no lo pediste vos, ignorá este mensaje. El banco nunca te va a pedir este código por teléfono ni por chat.`;
    return { asunto, html, text };
}

const esperarMs = ms => new Promise(r => setTimeout(r, ms));

// Envía un correo con la API de Resend. Reintenta una vez ante error de red, límite de velocidad (429) o error 5xx.
// El mismo Idempotency-Key en ambos intentos evita que el reintento duplique el correo.
async function enviarMail({ to, subject, html, text }) {
    if (!RESEND_API_KEY) {
        console.log(`\n🐍 [DESARROLLO] Correo a ${to} — ${subject}\n${text}\n`);
        return { simulado: true };
    }
    const fetch = (await import('node-fetch')).default;
    const idempotencyKey = `cobra-${crypto.randomUUID()}`;
    let ultimoError;
    for (let intento = 1; intento <= 2; intento++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        try {
            const r = await fetch(RESEND_URL, {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
                body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text }),
                signal: ctrl.signal
            });
            const datos = await r.json().catch(() => ({}));
            if (r.ok) return datos;
            ultimoError = new Error(`Resend respondió ${r.status}: ${datos.message || datos.name || 'sin detalle'}`);
            ultimoError.status = r.status;
            if (r.status === 403 && /resend\.dev/.test(MAIL_FROM)) console.error('   ↳ Con onboarding@resend.dev solo se puede enviar al correo dueño de la cuenta de Resend. Verificá un dominio y configurá MAIL_FROM.');
            if (!(r.status === 429 || r.status >= 500) || intento === 2) throw ultimoError;
            await esperarMs(r.status === 429 ? 1000 : 500);
        } catch (err) {
            if (err === ultimoError) throw err;            // error HTTP ya decidido arriba
            ultimoError = err;                              // error de red o timeout
            if (intento === 2) throw err;
        } finally { clearTimeout(timer); }
    }
    throw ultimoError;
}

// Genera, guarda (solo el hash) y envía un código. Aplica espera entre envíos y límites por email e IP.
async function solicitarCodigo(email, tipo, ip) {
    const ahora = Date.now();
    const previo = codigosVerificacion.get(email);
    if (previo) {
        const falta = Math.ceil((previo.enviadoEn + CODIGO_REENVIO_SEG * 1000 - ahora) / 1000);
        if (falta > 0) throw new ErrorVerificacion(429, `Esperá ${falta} segundos para pedir otro código.`, { esperar: falta });
    }
    const delEmail = enviosRecientes(enviosPorEmail, email, ahora);
    if (delEmail.length >= CODIGO_MAX_ENVIOS_HORA)
        throw new ErrorVerificacion(429, 'Pediste demasiados códigos para este email. Probá de nuevo en una hora.');
    const delIp = enviosRecientes(enviosPorIp, ip || 'desconocida', ahora);
    if (delIp.length >= CODIGO_MAX_ENVIOS_IP_HORA)
        throw new ErrorVerificacion(429, 'Demasiados pedidos de código desde tu conexión. Probá de nuevo más tarde.');

    const codigo = generarCodigo();
    const salt = crypto.randomBytes(8).toString('hex');
    const entrada = { hash: hashCodigo(codigo, salt), salt, expira: ahora + CODIGO_TTL_MIN * 60 * 1000, tipo, intentos: 0, enviadoEn: ahora };
    codigosVerificacion.set(email, entrada); // el código anterior queda invalidado (no hay await entre el chequeo y esta línea)
    delEmail.push(ahora); delIp.push(ahora);  // cuenta aunque el envío falle, para no martillar a Resend

    const { asunto, html, text } = plantillaCodigo(codigo, tipo);
    try {
        await enviarMail({ to: email, subject: asunto, html, text });
    } catch (err) {
        console.error('Error al enviar el código por email:', err.message);
        // No dejar vigente un código que nadie recibió
        if (codigosVerificacion.get(email) === entrada) previo ? codigosVerificacion.set(email, previo) : codigosVerificacion.delete(email);
        throw new ErrorVerificacion(502, 'No se pudo enviar el email. Probá de nuevo en unos minutos.');
    }
}

// Verifica el código. Lanza ErrorVerificacion si no corresponde. Con consumir=false el código sigue vigente
// (se usa en el registro: si falla otra validación, el usuario no tiene que pedir un código nuevo).
function verificarCodigo(email, tipo, ingresado, consumir = true) {
    const e = email ? codigosVerificacion.get(email) : null;
    if (!e || e.tipo !== tipo) throw new ErrorVerificacion(400, 'No se envió un código a este email. Solicitá uno primero.');
    if (Date.now() > e.expira) { codigosVerificacion.delete(email); throw new ErrorVerificacion(400, 'El código expiró. Solicitá uno nuevo.'); }
    const texto = String(ingresado ?? '').trim();
    if (!/^\d{6}$/.test(texto)) throw new ErrorVerificacion(400, 'El código tiene 6 dígitos.');

    if (!crypto.timingSafeEqual(hashCodigo(texto, e.salt), e.hash)) {
        e.intentos++;
        const quedan = CODIGO_MAX_INTENTOS - e.intentos;
        if (quedan <= 0) { codigosVerificacion.delete(email); throw new ErrorVerificacion(429, 'Superaste el límite de intentos. Solicitá un código nuevo.'); }
        throw new ErrorVerificacion(400, `Código incorrecto. Te quedan ${quedan} intento${quedan === 1 ? '' : 's'}.`);
    }
    if (consumir) codigosVerificacion.delete(email);
}

// Limpieza periódica para que los mapas en memoria no crezcan indefinidamente
setInterval(() => {
    const ahora = Date.now();
    for (const [k, v] of codigosVerificacion) if (ahora > v.expira + 60 * 1000) codigosVerificacion.delete(k);
    for (const mapa of [enviosPorEmail, enviosPorIp])
        for (const [k, lista] of mapa) { const vivos = lista.filter(t => ahora - t < 3600 * 1000); vivos.length ? mapa.set(k, vivos) : mapa.delete(k); }
}, 5 * 60 * 1000).unref();


// ═══════════════════════════════════════════════════════════════════════════════
// ENVIAR CÓDIGO DE VERIFICACIÓN (también sirve para reenviar)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/verificacion/enviar', async (req, res) => {
    const tipo = req.body?.tipo;
    const email = normalizarEmail(req.body?.email);
    if (!TIPOS_CODIGO.has(tipo)) return res.status(400).json({ error: 'Tipo de verificación inválido' });
    if (!email) return res.status(400).json({ error: 'Ingresá un email válido.' });

    const respuestaOk = { mensaje: `Código enviado a ${email}`, venceEnMin: CODIGO_TTL_MIN, reenvioEnSeg: CODIGO_REENVIO_SEG };
    try {
        const existe = await pool.query('SELECT id FROM Personas WHERE LOWER(email) = $1', [email]);
        if (tipo === 'registro' && existe.rows.length > 0) return res.status(400).json({ error: 'El email ya está registrado' });
        // Cambio de contraseña: solo se escribe a emails de clientes. Si no existe se responde igual, sin enviar nada,
        // para no revelar qué emails tienen cuenta ni usar el banco para mandar correos a cualquiera.
        if (tipo === 'password' && existe.rows.length === 0) return res.json(respuestaOk);

        await solicitarCodigo(email, tipo, req.ip);
        res.json(respuestaOk);
    } catch (err) {
        if (err instanceof ErrorVerificacion) return responderErrorVerificacion(res, err);
        console.error('Error en verificación:', err.message);
        res.status(500).json({ error: 'No se pudo enviar el email. Probá de nuevo en unos minutos.' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — REGISTRO (con verificación de email)
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/usuarios/registro', async (req, res) => {
    const { nombre, apellido, dni, password, codigoVerificacion } = req.body;
    const email = normalizarEmail(req.body.email);

    if (!nombre || !apellido || !dni || !email || !password || !codigoVerificacion) {
        return res.status(400).json({ error: "Faltan datos obligatorios" });
    }
    if (!/^\d{7,8}$/.test(String(dni))) return res.status(400).json({ error: "El DNI debe tener 7 u 8 dígitos" });

    // Verificar código (sin consumirlo todavía: si falla otra validación, no hace falta pedir uno nuevo)
    try { verificarCodigo(email, 'registro', codigoVerificacion, false); }
    catch (err) { if (err instanceof ErrorVerificacion) return responderErrorVerificacion(res, err); throw err; }

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
        codigosVerificacion.delete(email); // código usado
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
            WHERE pr.id_persona = $1 AND m.oculto = FALSE
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

        if (cuentaResult.rows.length === 0) return res.status(404).json({ error: moneda === 'USD' ? "Todavía no abriste tu caja en USD" : "Cuenta no encontrada" });
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
                moneda,
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

        // Verificar código (el emitido para cambiar contraseña; uno de registro no sirve acá)
        try { verificarCodigo(normalizarEmail(email), 'password', codigoVerificacion); }
        catch (err) { if (err instanceof ErrorVerificacion) return responderErrorVerificacion(res, err); throw err; }

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
// BORRAR ACTIVIDAD (la oculta del historial del cliente; el panel admin conserva el registro)
// ═══════════════════════════════════════════════════════════════════════════════
app.delete('/api/usuarios/:id/actividad', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    try {
        const r = await pool.query(`
            UPDATE Movimientos SET oculto = TRUE
            WHERE oculto = FALSE AND id_cuenta IN (
                SELECT cb.id_cuenta FROM Cuentas_Bancarias cb
                JOIN Productos pr ON pr.id_producto = cb.id_producto
                WHERE pr.id_persona = $1
            )
        `, [idPersona]);
        res.json({ mensaje: 'Actividad borrada', borradas: r.rowCount });
    } catch (err) {
        res.status(500).json({ error: 'No se pudo borrar la actividad' });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COTIZACIÓN DEL DÓLAR (MonedAPI — https://monedapi.ar)
// ═══════════════════════════════════════════════════════════════════════════════
const MONEDAPI_URL = process.env.MONEDAPI_URL || 'https://monedapi.ar/api/v2';
const COTIZACION_TTL_MS = 60 * 1000; // MonedAPI publica cada 5 min y cachea 60 s: no tiene sentido preguntar más seguido
const TIPOS_DOLAR = { oficial: 'Dólar Oficial', blue: 'Dólar Blue', bolsa: 'Dólar MEP', ccl: 'Contado con liqui', bna: 'Dólar Banco Nación', tarjeta: 'Dólar tarjeta' };
const cacheCotizacion = new Map(); // tipo -> { datos, obtenidoEn }

async function pedirCotizacion(tipo) {
    const fetch = (await import('node-fetch')).default;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
        const r = await fetch(`${MONEDAPI_URL}/usd/${tipo}`, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
        if (!r.ok) throw new Error(`MonedAPI respondió ${r.status}`);
        const d = await r.json();
        if (typeof d.buy !== 'number' || typeof d.sell !== 'number') throw new Error('Respuesta inesperada de MonedAPI');
        return {
            tipo,
            nombre: d.name || TIPOS_DOLAR[tipo],
            compra: d.buy,
            venta: d.sell,
            actualizado: d.updatedAt,       // última vez que cambió el valor (hora argentina)
            verificado: d.lastScrapedAt,    // última vez que una fuente lo confirmó
            variacion: d.change ? { monto: d.change.amount, porcentaje: d.change.percent } : null,
            fuente: 'MonedAPI'
        };
    } finally { clearTimeout(timer); }
}

app.get('/api/cotizacion/dolar', async (req, res) => {
    const tipo = String(req.query.tipo || 'oficial').toLowerCase();
    if (!TIPOS_DOLAR[tipo]) return res.status(400).json({ error: `Tipo inválido. Usá: ${Object.keys(TIPOS_DOLAR).join(', ')}` });

    const guardado = cacheCotizacion.get(tipo);
    if (guardado && Date.now() - guardado.obtenidoEn < COTIZACION_TTL_MS) return res.json({ ...guardado.datos, desactualizada: false });

    try {
        const datos = await pedirCotizacion(tipo);
        cacheCotizacion.set(tipo, { datos, obtenidoEn: Date.now() });
        res.json({ ...datos, desactualizada: false });
    } catch (err) {
        console.error('Error consultando MonedAPI:', err.message);
        // Si falló pero hay un valor previo, se sirve ese marcándolo como desactualizado (con su fecha original)
        if (guardado) return res.json({ ...guardado.datos, desactualizada: true });
        res.status(503).json({ error: 'No se pudo obtener la cotización en este momento' });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
// RENDIMIENTOS (intereses diarios sobre el saldo disponible)
// ═══════════════════════════════════════════════════════════════════════════════
// TNA (%) por moneda. Configurable en .env: RENDIMIENTO_TNA_ARS, RENDIMIENTO_TNA_USD
const leerTasa = (v, porDefecto) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : porDefecto; };
const TASAS_ANUALES = {
    ARS: leerTasa(process.env.RENDIMIENTO_TNA_ARS, 30),
    USD: leerTasa(process.env.RENDIMIENTO_TNA_USD, 1)
};
const DIAS_AÑO = 365;
const MAX_DIAS_ATRASO = 31; // tope de días que se recuperan si el servidor estuvo apagado

const SQL_RENDIMIENTOS = `CREATE TABLE IF NOT EXISTS Rendimientos (
    id_rendimiento SERIAL PRIMARY KEY,
    id_cuenta INTEGER NOT NULL REFERENCES Cuentas_Bancarias(id_cuenta) ON DELETE CASCADE,
    fecha DATE NOT NULL,
    saldo_base DECIMAL(15, 2) NOT NULL,
    tasa_anual DECIMAL(7, 4) NOT NULL,
    interes DECIMAL(15, 2) NOT NULL CHECK (interes >= 0),
    creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id_cuenta, fecha)
)`;

// Fecha de hoy en Argentina como 'YYYY-MM-DD' (independiente de la zona horaria del servidor)
function fechaArgentina(desplazarDias = 0) {
    const base = new Date(Date.now() + desplazarDias * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit' }).format(base);
}
function sumarDias(fechaISO, dias) {
    const d = new Date(fechaISO + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

// Devenga UN día en UNA caja. El interés se calcula en la base con NUMERIC (sin errores de coma flotante):
//   interés = saldo × TNA% / 100 / 365, redondeado a centavos. Se acredita al saldo y queda como movimiento.
async function devengarDia(idCuenta, moneda, fecha) {
    const tna = TASAS_ANUALES[moneda];
    if (tna === undefined) return false;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const c = await client.query('SELECT saldo FROM Cuentas_Bancarias WHERE id_cuenta = $1 FOR UPDATE', [idCuenta]);
        if (c.rows.length === 0) { await client.query('ROLLBACK'); return false; }
        const calc = await client.query('SELECT ROUND($1::numeric * $2::numeric / 100 / $3::numeric, 2) AS interes', [c.rows[0].saldo, tna, DIAS_AÑO]);
        const interes = calc.rows[0].interes;

        // UNIQUE (id_cuenta, fecha): si ya estaba devengado ese día, no inserta y no acredita nada
        const ins = await client.query(
            `INSERT INTO Rendimientos (id_cuenta, fecha, saldo_base, tasa_anual, interes) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id_cuenta, fecha) DO NOTHING RETURNING id_rendimiento`,
            [idCuenta, fecha, c.rows[0].saldo, tna, interes]);

        if (ins.rows.length > 0 && parseFloat(interes) > 0) {
            await client.query('UPDATE Cuentas_Bancarias SET saldo = saldo + $1 WHERE id_cuenta = $2', [interes, idCuenta]);
            await client.query(
                `INSERT INTO Movimientos (id_cuenta, tipo, monto, detalle) VALUES ($1, 'Rendimiento diario', $2, $3)`,
                [idCuenta, interes, `Intereses del ${fecha} · TNA ${tna}%`]);
        }
        await client.query('COMMIT');
        return ins.rows.length > 0;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error(`Error devengando cuenta ${idCuenta} (${fecha}):`, err.message);
        return false;
    } finally { client.release(); }
}

let devengandoEnCurso = false;
let ultimoDiaDevengado = null;

// Recorre todas las cajas y devenga los días que falten hasta AYER (un día se devenga recién cuando termina).
async function devengarRendimientos() {
    if (devengandoEnCurso) return;
    devengandoEnCurso = true;
    try {
        const hoy = fechaArgentina();
        const ayer = sumarDias(hoy, -1);
        const { rows } = await pool.query(`
            SELECT cb.id_cuenta, cb.moneda,
                   (SELECT MAX(r.fecha) FROM Rendimientos r WHERE r.id_cuenta = cb.id_cuenta)::text AS ultimo,
                   pr.fecha_alta::date::text AS alta
            FROM Cuentas_Bancarias cb JOIN Productos pr ON pr.id_producto = cb.id_producto
        `);
        let acreditados = 0;
        for (const cb of rows) {
            let desde;
            if (cb.ultimo) desde = sumarDias(cb.ultimo, 1);
            else if (cb.alta < ayer) desde = ayer;      // primera vez: solo ayer, y solo si la caja ya existía antes de ese día
            else continue;
            const tope = sumarDias(ayer, -(MAX_DIAS_ATRASO - 1));
            if (desde < tope) desde = tope;
            for (let f = desde; f <= ayer; f = sumarDias(f, 1)) {
                if (await devengarDia(cb.id_cuenta, cb.moneda, f)) acreditados++;
            }
        }
        ultimoDiaDevengado = hoy;
        if (acreditados) console.log(`✓ Rendimientos devengados: ${acreditados} (hasta ${ayer})`);
    } catch (err) {
        console.error('Error devengando rendimientos:', err.message);
    } finally { devengandoEnCurso = false; }
}

// Cada minuto revisa si cambió el día (hora argentina); si cambió, devenga el día que terminó
setInterval(() => { if (fechaArgentina() !== ultimoDiaDevengado) devengarRendimientos(); }, 60 * 1000);

app.get('/api/usuarios/:id/rendimientos', async (req, res) => {
    const idPersona = parseInt(req.params.id);
    const moneda = req.query.moneda === 'USD' ? 'USD' : 'ARS';
    const dias = Math.min(Math.max(parseInt(req.query.dias) || 30, 1), 365);
    if (!Number.isInteger(idPersona)) return res.status(400).json({ error: 'Usuario inválido' });
    try {
        const cuenta = await pool.query(`
            SELECT cb.id_cuenta, cb.saldo FROM Cuentas_Bancarias cb
            JOIN Productos pr ON pr.id_producto = cb.id_producto
            WHERE pr.id_persona = $1 AND cb.moneda = $2 LIMIT 1
        `, [idPersona, moneda]);
        if (cuenta.rows.length === 0) return res.status(404).json({ error: moneda === 'USD' ? 'Todavía no abriste tu caja en USD' : 'Cuenta no encontrada' });
        const { id_cuenta, saldo } = cuenta.rows[0];
        const tna = TASAS_ANUALES[moneda];

        const [total, mes, diarios, estimado] = await Promise.all([
            pool.query('SELECT COALESCE(SUM(interes), 0) AS total, COUNT(*) AS dias FROM Rendimientos WHERE id_cuenta = $1', [id_cuenta]),
            pool.query(`SELECT COALESCE(SUM(interes), 0) AS total FROM Rendimientos
                        WHERE id_cuenta = $1 AND fecha >= date_trunc('month', $2::date)`, [id_cuenta, fechaArgentina()]),
            pool.query(`SELECT fecha::text AS fecha, saldo_base, tasa_anual, interes FROM Rendimientos
                        WHERE id_cuenta = $1 AND fecha >= $2::date - $3::int ORDER BY fecha DESC`, [id_cuenta, fechaArgentina(), dias]),
            pool.query('SELECT ROUND($1::numeric * $2::numeric / 100 / $3::numeric, 2) AS interes', [saldo, tna, DIAS_AÑO])
        ]);

        res.json({
            moneda,
            saldo: parseFloat(saldo),
            tasaAnual: tna,                                                // TNA (%)
            tasaDiaria: parseFloat((tna / DIAS_AÑO).toFixed(6)),           // % por día
            estimadoDiario: parseFloat(estimado.rows[0].interes),          // lo que rendiría hoy el saldo actual
            acumulado: parseFloat(total.rows[0].total),                    // ganancias desde siempre
            acumuladoMes: parseFloat(mes.rows[0].total),
            diasAcreditados: parseInt(total.rows[0].dias),
            diarios: diarios.rows.map(r => ({ fecha: r.fecha, saldoBase: parseFloat(r.saldo_base), tasaAnual: parseFloat(r.tasa_anual), interes: parseFloat(r.interes) })),
            diasConsultados: dias
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'No se pudieron obtener los rendimientos' });
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

// Columna para ocultar movimientos del historial del cliente (equivale a init/08_movimientos_oculto.sql)
pool.query('ALTER TABLE Movimientos ADD COLUMN IF NOT EXISTS oculto BOOLEAN NOT NULL DEFAULT FALSE')
    .catch(err => console.error('No se pudo agregar la columna oculto:', err.message));