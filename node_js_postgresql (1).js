/**
 * Бекенд-сервер для приложения «Чистый Лист» с базой данных PostgreSQL.
 * Хранит аккаунты, хэши паролей (scrypt), сессии и прогресс привычек в PostgreSQL (JSONB).
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);

// Пул подключений к PostgreSQL по внутренней сети Docker (хост: postgres, порт: 5432)
const pool = new Pool({
    host: process.env.PGHOST || 'postgres',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'chistiy_list',
    user: process.env.PGUSER || 'chistiy_user',
    password: process.env.PGPASSWORD || 'chistiy_secret_pass_change_me',
    max: 15,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

// Автоматическое создание таблиц при старте сервера
async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                login VARCHAR(128) PRIMARY KEY,
                display_name VARCHAR(255) NOT NULL,
                avatar VARCHAR(32) NOT NULL DEFAULT '🦁',
                password_hash TEXT NOT NULL,
                share_leaderboard BOOLEAN NOT NULL DEFAULT TRUE,
                state JSONB NOT NULL DEFAULT '{}'::jsonb,
                summary JSONB NOT NULL DEFAULT '{"cleanDays":0,"goodTodayMinutes":0,"totalGoodHours":0,"habitsCount":0}'::jsonb,
                created_at BIGINT NOT NULL,
                updated_at BIGINT NOT NULL
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                token VARCHAR(128) PRIMARY KEY,
                login VARCHAR(128) NOT NULL REFERENCES users(login) ON DELETE CASCADE,
                created_at BIGINT NOT NULL
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login);
        `);

        console.log('✅ Таблицы PostgreSQL (users, sessions) готовы к работе.');
    } finally {
        client.release();
    }
}

// Хэширование и проверка пароля (встроенный криптографический модуль scrypt)
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [salt, originalHash] = String(storedHash || '').split(':');
    if (!salt || !originalHash) return false;
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
}

// Формирование публичной таблицы лидеров («Друзья и Команда») из PostgreSQL
async function buildLeaderboard() {
    const result = await pool.query(`
        SELECT login, display_name, avatar, summary, updated_at, created_at
        FROM users
        WHERE share_leaderboard = TRUE
        ORDER BY
            COALESCE((summary->>'cleanDays')::int, 0) DESC,
            COALESCE((summary->>'goodTodayMinutes')::int, 0) DESC,
            updated_at DESC
        LIMIT 100
    `);

    return result.rows.map(row => ({
        login: row.login,
        displayName: row.display_name || row.login,
        avatar: row.avatar || '🦁',
        summary: row.summary || { cleanDays: 0, goodTodayMinutes: 0, totalGoodHours: 0, habitsCount: 0 },
        updatedAt: Number(row.updated_at || row.created_at)
    }));
}

// Чтение JSON-тела HTTP-запроса
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 2 * 1024 * 1024) {
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
}

// Получение авторизованного пользователя по заголовку Authorization: Bearer <token>
async function getUserByReq(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    if (!token) return null;

    const result = await pool.query(
        `SELECT u.login, u.display_name, u.avatar, u.share_leaderboard, u.state, u.summary
         FROM sessions s
         JOIN users u ON u.login = s.login
         WHERE s.token = $1
         LIMIT 1`,
        [token]
    );

    return result.rows[0] || null;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    try {
        // 1. Проверка работоспособности сервера и соединения с PostgreSQL
        if (req.method === 'GET' && url.pathname === '/api/health') {
            await pool.query('SELECT 1');
            return sendJson(res, 200, { ok: true, service: 'chistiy-list-backend', db: 'postgresql' });
        }

        // 2. Получение зала славы друзей
        if (req.method === 'GET' && url.pathname === '/api/leaderboard') {
            const leaderboard = await buildLeaderboard();
            return sendJson(res, 200, { leaderboard });
        }

        // 3. Регистрация нового пользователя
        if (req.method === 'POST' && url.pathname === '/api/auth/register') {
            const body = await readJsonBody(req);
            const login = String(body.login || '').trim().toLowerCase();
            const password = String(body.password || '');

            if (!login || login.length < 2) {
                return sendJson(res, 400, { error: 'Логин должен содержать минимум 2 символа' });
            }
            if (password.length < 4) {
                return sendJson(res, 400, { error: 'Пароль должен быть не короче 4 символов' });
            }

            const existing = await pool.query('SELECT login FROM users WHERE login = $1', [login]);
            if (existing.rowCount > 0) {
                return sendJson(res, 409, { error: 'Этот логин уже занят. Выберите другой или войдите.' });
            }

            const now = Date.now();
            const displayName = String(body.displayName || login).trim();
            const avatar = String(body.avatar || '🦁');
            const passwordHash = hashPassword(password);
            const initialState = (body.initialState && typeof body.initialState === 'object') ? body.initialState : {};
            const summary = (body.summary && typeof body.summary === 'object')
                ? body.summary
                : { cleanDays: 0, goodTodayMinutes: 0, totalGoodHours: 0, habitsCount: 0 };

            const token = crypto.randomBytes(32).toString('hex');

            await pool.query(
                `INSERT INTO users (login, display_name, avatar, password_hash, share_leaderboard, state, summary, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, TRUE, $5::jsonb, $6::jsonb, $7, $7)`,
                [login, displayName, avatar, passwordHash, JSON.stringify(initialState), JSON.stringify(summary), now]
            );

            await pool.query(
                `INSERT INTO sessions (token, login, created_at) VALUES ($1, $2, $3)`,
                [token, login, now]
            );

            const leaderboard = await buildLeaderboard();

            return sendJson(res, 201, {
                token,
                user: {
                    login,
                    displayName,
                    avatar,
                    shareLeaderboard: true
                },
                state: initialState,
                leaderboard
            });
        }

        // 4. Вход в существующий аккаунт
        if (req.method === 'POST' && url.pathname === '/api/auth/login') {
            const body = await readJsonBody(req);
            const login = String(body.login || '').trim().toLowerCase();
            const password = String(body.password || '');

            const userRes = await pool.query(
                `SELECT login, display_name, avatar, password_hash, share_leaderboard, state
                 FROM users WHERE login = $1 LIMIT 1`,
                [login]
            );

            const userRow = userRes.rows[0];
            if (!userRow || !verifyPassword(password, userRow.password_hash)) {
                return sendJson(res, 401, { error: 'Неверный логин или пароль' });
            }

            const token = crypto.randomBytes(32).toString('hex');
            await pool.query(
                `INSERT INTO sessions (token, login, created_at) VALUES ($1, $2, $3)`,
                [token, userRow.login, Date.now()]
            );

            const leaderboard = await buildLeaderboard();

            return sendJson(res, 200, {
                token,
                user: {
                    login: userRow.login,
                    displayName: userRow.display_name,
                    avatar: userRow.avatar,
                    shareLeaderboard: userRow.share_leaderboard
                },
                state: userRow.state || {},
                leaderboard
            });
        }

        // 5. Получение личных данных авторизованного пользователя
        if (req.method === 'GET' && url.pathname === '/api/state') {
            const user = await getUserByReq(req);
            if (!user) return sendJson(res, 401, { error: 'Не авторизован' });

            const leaderboard = await buildLeaderboard();

            return sendJson(res, 200, {
                user: {
                    login: user.login,
                    displayName: user.display_name,
                    avatar: user.avatar,
                    shareLeaderboard: user.share_leaderboard
                },
                state: user.state || {},
                leaderboard
            });
        }

        // 6. Сохранение привычек и прогресса пользователя в PostgreSQL
        if (req.method === 'POST' && url.pathname === '/api/state') {
            const user = await getUserByReq(req);
            if (!user) return sendJson(res, 401, { error: 'Не авторизован' });

            const body = await readJsonBody(req);
            const newState = (body.state && typeof body.state === 'object') ? body.state : user.state;
            const newSummary = (body.summary && typeof body.summary === 'object') ? body.summary : user.summary;
            const newShare = (typeof body.shareLeaderboard === 'boolean') ? body.shareLeaderboard : user.share_leaderboard;

            await pool.query(
                `UPDATE users
                 SET state = $1::jsonb,
                     summary = $2::jsonb,
                     share_leaderboard = $3,
                     updated_at = $4
                 WHERE login = $5`,
                [JSON.stringify(newState), JSON.stringify(newSummary), newShare, Date.now(), user.login]
            );

            const leaderboard = await buildLeaderboard();

            return sendJson(res, 200, {
                ok: true,
                leaderboard
            });
        }

        return sendJson(res, 404, { error: 'Маршрут не найден' });
    } catch (err) {
        console.error('Ошибка сервера:', err);
        return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
});

// Запуск сервера после инициализации PostgreSQL
async function start() {
    for (let attempt = 1; attempt <= 15; attempt++) {
        try {
            await initDatabase();
            break;
        } catch (err) {
            console.warn(`⏳ Ожидание готовности PostgreSQL (попытка ${attempt}/15)...`, err.message);
            if (attempt === 15) {
                console.error('❌ Не удалось подключиться к PostgreSQL.');
                process.exit(1);
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Chistiy List Backend запущен на порту ${PORT} (БД: PostgreSQL @ ${process.env.PGHOST || 'postgres'}:5432)`);
    });
}

start();