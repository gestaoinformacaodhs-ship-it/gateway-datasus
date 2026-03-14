FROM node:18-alpine

# Instala dependências do sistema necessárias para compilação e conexões de rede
# Adicionado 'libc6-compat' e 'tzdata' para garantir estabilidade com módulos nativos
RUN apk add --no-cache \
    python3 \
    g++ \
    make \
    sqlite-dev \
    py3-setuptools \
    libc6-compat \
    tzdata

# Define o fuso horário (importante para logs de download do DATASUS)
ENV TZ=America/Sao_Paulo

WORKDIR /app

# Copia arquivos de dependências primeiro (aproveita o cache do Docker)
COPY package*.json ./

# Instala dependências compilando o sqlite3 para Alpine
# Limpa o cache do npm para manter a imagem leve
RUN npm install --build-from-source && \
    npm cache clean --force

# Copia o restante do código fonte
COPY . .

# Garante que o banco de dados exista e tenha permissões de escrita/leitura
# Criar o arquivo aqui evita erros de "Read-only file system" no Docker
RUN touch database.db && chmod 666 database.db

# Expõe a porta do Gateway
EXPOSE 3000

# Usa o sinal de interrupção correto para o Node.js não travar ao parar o container
STOPSIGNAL SIGINT

CMD ["node", "server.js"]