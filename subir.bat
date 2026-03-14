@echo off
echo 🚀 Iniciando processo de subida para GitHub...

:: 1. Adiciona as mudanças
git add .

:: 2. Pede para você digitar o motivo da alteração
set /p mensagem="Digite o motivo da alteracao: "

:: 3. Faz o commit com sua mensagem
git commit -m "%mensagem%"

:: 4. Sobe para o GitHub
echo 📤 Enviando para o GitHub...
git push origin main

echo.
echo ✅ Sucesso! O GitHub foi atualizado.
echo 🔄 Agora o Render vai iniciar o deploy automaticamente.
echo 💡 Lembre-se: Verifique se a BREVO_API_KEY esta configurada no Render!
pause