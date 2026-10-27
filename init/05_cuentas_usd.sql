-- 05_cuentas_usd.sql
-- Opcional. NO es obligatorio correrlo: Productos y Cuentas_Bancarias ya admiten
-- varias cajas por persona (una fila de Productos por cada caja), así que la caja en
-- USD funciona sin cambiar el esquema.
-- Este script solo documenta el estado esperado y deja una verificación de control.

-- Confirma que no haya quedado ninguna cuenta sin moneda definida
-- (no debería haber filas; si las hay, revisar antes de usar el flujo de USD)
SELECT * FROM Cuentas_Bancarias WHERE moneda IS NULL OR moneda = '';
