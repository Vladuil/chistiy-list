version: "3.9"

services:
  # КОНТЕЙНЕР 1: База данных PostgreSQL (доступна ТОЛЬКО внутри сети app-network)
  postgres:
    image: postgres:16-alpine
    container_name: chistiy-list-postgres
    environment:
      - POSTGRES_DB=${POSTGRES_DB:-chistiy_list}
      - POSTGRES_USER=${POSTGRES_USER:-chistiy_user}
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD:-chistiy_secret_pass_change_me}
    volumes:
      - postgres_db_data:/var/lib/postgresql/data
    # ВАЖНО: секция ports отсутствует — база НЕ торчит наружу на хост-машину.
    # Доступ к порту 5432 есть только у контейнеров внутри внутренней сети app-network.
    expose:
      - "5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER:-chistiy_user} -d $${POSTGRES_DB:-chistiy_list}"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped
    networks:
      - app-network

  # КОНТЕЙНЕР 2: Бекенд (Node.js API + подключение к PostgreSQL)
  backend:
    image: node:20-alpine
    container_name: chistiy-list-backend
    working_dir: /app
    command: sh -c "[ -d node_modules/pg ] || npm install --no-audit --no-fund; node server.js"
    environment:
      - PORT=3000
      - PGHOST=postgres
      - PGPORT=5432
      - PGDATABASE=${POSTGRES_DB:-chistiy_list}
      - PGUSER=${POSTGRES_USER:-chistiy_user}
      - PGPASSWORD=${POSTGRES_PASSWORD:-chistiy_secret_pass_change_me}
    volumes:
      - ./package.json:/app/package.json:ro
      - ./server.js:/app/server.js:ro
      - backend_node_modules:/app/node_modules
    expose:
      - "3000"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - app-network

  # КОНТЕЙНЕР 3: Фронтенд (Nginx — единственная точка входа снаружи)
  frontend:
    image: nginx:alpine
    container_name: chistiy-list-frontend
    ports:
      - "${APP_PORT:-80}:80"
    volumes:
      - ./habit_tracker.html:/usr/share/nginx/html/index.html:ro
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - backend
    restart: unless-stopped
    networks:
      - app-network

volumes:
  # Постоянный том для данных PostgreSQL (сохраняется при перезапусках и обновлениях)
  postgres_db_data:
  # Кэш node_modules для мгновенного перезапуска бекенда
  backend_node_modules:

networks:
  app-network:
    driver: bridge