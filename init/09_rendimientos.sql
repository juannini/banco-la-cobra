-- 09_rendimientos.sql
-- Rendimientos diarios sobre el saldo disponible (un registro por caja y por día).
-- El server.js también crea esta tabla solo al arrancar, así que correr esto es opcional.
CREATE TABLE IF NOT EXISTS Rendimientos (
    id_rendimiento SERIAL PRIMARY KEY,
    id_cuenta INTEGER NOT NULL REFERENCES Cuentas_Bancarias(id_cuenta) ON DELETE CASCADE,
    fecha DATE NOT NULL,                              -- día que se devenga (hora argentina)
    saldo_base DECIMAL(15, 2) NOT NULL,               -- saldo sobre el que se calculó
    tasa_anual DECIMAL(7, 4) NOT NULL,                -- TNA aplicada, en %
    interes DECIMAL(15, 2) NOT NULL CHECK (interes >= 0),
    creado TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id_cuenta, fecha)                         -- evita acreditar dos veces el mismo día
);
CREATE INDEX IF NOT EXISTS ix_rendimientos_cuenta_fecha ON Rendimientos (id_cuenta, fecha DESC);
