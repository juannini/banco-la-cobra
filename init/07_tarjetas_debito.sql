-- 07_tarjetas_debito.sql
-- Tarjeta de débito virtual (número, vencimiento y CVV simulados). El server.js la crea solo al arrancar,
-- y genera la tarjeta de cada usuario la primera vez que abre su cuenta, así que correr esto es opcional.
CREATE TABLE IF NOT EXISTS Tarjetas_Debito (
    id_persona INTEGER NOT NULL REFERENCES Personas(id) ON DELETE CASCADE,
    moneda VARCHAR(10) NOT NULL,
    numero VARCHAR(16) NOT NULL UNIQUE,
    vencimiento VARCHAR(5) NOT NULL,
    cvv VARCHAR(3) NOT NULL,
    PRIMARY KEY (id_persona, moneda)
);
