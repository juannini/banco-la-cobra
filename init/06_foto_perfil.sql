-- 06_foto_perfil.sql
-- Foto de perfil del usuario (data URL JPEG/PNG/WEBP, ya reducida a 256x256 en el navegador).
-- El server.js también agrega la columna solo al arrancar, así que correr esto es opcional.
ALTER TABLE Personas ADD COLUMN IF NOT EXISTS foto TEXT;
