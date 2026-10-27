-- 04_central_migration.sql
-- Ejecutar UNA vez y ANTES de levantar el server.js nuevo (se puede repetir sin romper nada).

-- 1. Movimientos: ID de la transacción del Banco Central (evita acreditar dos veces)
ALTER TABLE Movimientos ADD COLUMN IF NOT EXISTS id_central VARCHAR(24);

-- Las recibidas anteriores guardaban el ID entre corchetes en `detalle`.
-- Sin este backfill, el polling nuevo volvería a acreditar las transferencias de los últimos 30 min.
UPDATE Movimientos
SET id_central = substring(detalle FROM '\[([0-9a-f]{24})\]')
WHERE tipo = 'Transferencia interbancaria recibida' AND id_central IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_movimientos_id_central ON Movimientos (id_central);

-- 2. Deudas informadas a la Central de Deudores (un informe por persona)
CREATE TABLE IF NOT EXISTS Deudas_Informadas (
    id_deuda SERIAL PRIMARY KEY,
    id_persona INTEGER NOT NULL UNIQUE REFERENCES Personas(id) ON DELETE CASCADE,
    monto DECIMAL(15, 2) NOT NULL CHECK (monto >= 0),
    situacion INTEGER NOT NULL CHECK (situacion BETWEEN 1 AND 5),
    fecha_informe TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Protección contra saldos negativos y monedas inválidas.
-- Antes de correr esto, verificá que no haya filas que ya lo incumplan:
--   SELECT * FROM Cuentas_Bancarias WHERE saldo < 0 OR moneda NOT IN ('ARS', 'USD');
ALTER TABLE Cuentas_Bancarias DROP CONSTRAINT IF EXISTS chk_saldo_no_negativo;
ALTER TABLE Cuentas_Bancarias DROP CONSTRAINT IF EXISTS chk_moneda;
ALTER TABLE Cuentas_Bancarias
    ADD CONSTRAINT chk_saldo_no_negativo CHECK (saldo >= 0),
    ADD CONSTRAINT chk_moneda CHECK (moneda IN ('ARS', 'USD'));

-- Solo si ya habías corrido la versión anterior de este archivo (opcional, limpia lo que ya no se usa):
--   DROP TABLE IF EXISTS Transacciones;
--   ALTER TABLE Cuentas_Bancarias DROP COLUMN IF EXISTS sincronizada_central;
--   ALTER TABLE Cuentas_Bancarias DROP CONSTRAINT IF EXISTS chk_cbu_22, DROP CONSTRAINT IF EXISTS chk_alias_formato;
--   ALTER TABLE Personas DROP CONSTRAINT IF EXISTS chk_dni_7_8;
