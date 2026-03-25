@echo off
echo 🚀 Iniciando processo de subida para GitHub...

:: 1. Adiciona as mudanças
git add .

:: 2. Captura a mensagem de commit (remove aspas se existirem)
set msg=%*
if defined msg set msg=%msg:"=%
if not defined msg set msg=Atualizacao automatica pelo terminal

:: 3. Faz o commit
git commit -m "%msg%"

:: 4. Puxa atuacoes remotas para evitar conflitos de versao
echo 📥 Sincronizando com o GitHub...
git pull origin main --rebase

:: 5. Sobe para o GitHub
echo 📤 Enviando para o GitHub...
git push origin main

echo.
echo ✅ Sucesso! O GitHub foi atualizado.