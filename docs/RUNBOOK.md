# RUNBOOK — деплой, перезапуск, инциденты

Версия 1.1 · соответствует состоянию кода после Фазы 1 (сборщик данных, `src/collector.ts`) и первого рабочего среза kill switch уровня 1 (`src/killswitch-listener.ts`). `strategy/`, `risk/`, `execution/` — чистые функции без реального размещения ордеров, ещё не подключены к живому циклу. `watchdog/` (уровень 3, внешний хост) и уровни 2 kill switch ещё не написаны.

---

## 1. Локальная разработка

### Первый запуск

```bash
cp .env.example .env      # если .env ещё нет — заполнить вручную, не через чат
docker compose up -d      # поднимает timescale/timescaledb:2.29.1-pg18
npm install
npm run migrate:up
npm run build
npm run collect
```

`DATABASE_URL` в `.env.example` уже согласован с кредами в `docker-compose.yml` (`user`/`password`/`trade_bot` на `localhost:5432`) — трогать не нужно, если не меняешь `docker-compose.yml`.

### Повседневные команды

| Команда | Что делает |
|---|---|
| `npm test` | Прогон всех тестов. Часть тестов (`test/storage/`, `test/market-data/collect*`) требует поднятого `docker compose up -d` — упадут с понятной ошибкой `DATABASE_URL is not set`/connection refused, если БД не запущена |
| `npm run typecheck` | `tsc --noEmit`, без сборки |
| `npm run lint` | ESLint, включая архитектурную проверку границ модулей (раздел 6) |
| `npm run build` | Компилирует `src/` (без `test/`) в `dist/` |
| `npm run collect` | Собранный сборщик Фазы 1. Требует `.env` и поднятый Postgres |
| `npm run migrate:up` / `migrate:down` | Миграции. `-j sql` — миграции пишутся и читаются как обычный SQL (ADR-004) |

**Живой инцидент (VPS-деплой, 2026-08-06): `--envPath .env` у `node-pg-migrate` может не прочитать файл** — упало с `The DATABASE_URL environment variable is not set`, хотя тот же `.env` секундой позже штатно читался и `node --env-file=.env`, и `EnvironmentFile=` у systemd (оба сработали чисто). Похоже на баг парсера конкретно у `node-pg-migrate`, причина не выяснена до конца (подозрение на кириллические комментарии в файле). Обходной путь, подтверждён рабочим: передать `DATABASE_URL` явной переменной окружения вместо `--envPath`:
```bash
DATABASE_URL='postgres://user:password@localhost:5432/trade_bot' npx node-pg-migrate up -j sql --no-check-order
```
Только для самого шага миграции — `npm run collect`/systemd-юниты этой проблемы не имеют, `--envPath`/`EnvironmentFile` их не касаются.

### Проверка, что БД жива

```bash
docker exec trade-bot-postgres psql -U user -d trade_bot -c "\dt"
```

---

## 2. Процессы (текущее и будущее состояние)

| Процесс | Файл | Статус |
|---|---|---|
| Сборщик данных | `src/collector.ts` | **Работает.** |
| `killswitch-listener` | `src/killswitch-listener.ts` | **Работает** — отдельный OS-процесс (RR-31), два независимых пути уровня 1 (файл-флаг + Telegram). Команды: `/stop`, `/flatten`, `/resume`, `/status`, `/add <chat_id>`, `/delete <chat_id>` (только root admin), `/menu`/`/start` (inline-кнопки: 📊 Статус/❓ Помощь/✅ Resume — сразу; 🛑 Stop/🔥 Flatten — с шагом подтверждения), `/help` (полный список в реальном Telegram, `src/killswitch/commandRouter.ts`'s `COMMAND_DOCS`). Живой прогон подтверждён: self-test, взведение по флагу, запись в `halt_state`, снятие только явной командой |
| `trader` (стратегия + риск + исполнение) | — | Не написан. `strategy/`/`risk/`/`execution/` существуют как чистые функции, но ничего не вызывает их на реальном цикле — появится при переходе к Фазе 2 |
| `watchdog` | — | Не написан. Должен жить на **другом** хосте (RR-35, AR-09 в RISK-REGISTER.md) |

`src/collector.ts` сам по себе не имеет kill switch и не должен его иметь — он не открывает позиций, ему нечего останавливать в смысле раздела 7 брифа. Уровень риска этого процесса — потеря данных при простое, не потеря денег.

**`killswitch-listener` сегодня умеет поднимать и снимать флаги `HALT_NEW`/`FLATTEN_ALL`, персистентно и наблюдаемо — но пока нечего физически "флэттить".** `execution/` не размещает реальных ордеров, значит `/flatten` взводит состояние, но не отменяет и не закрывает ничего на бирже (закрывать ещё нечего). Это ожидаемо для текущей фазы, не баг — состояние строится заранее, чтобы Фаза 3 подключала исполнение к уже проверенному контуру безопасности, а не наоборот.

---

## 3. Деплой на VPS

**Статус: VPS выбран, арендован и в проде с 2026-08-06** (Linode, 139.162.24.37 — см. раздел 7). Раздел ниже описывает уже выполненную процедуру подготовки/выкладки, не гипотетическую — она задокументирована здесь как воспроизводимая инструкция на случай пересоздания сервера.

### Подготовка сервера (один раз)

1. VPS с фиксированным IP (для будущего белого списка API-ключа в Фазе 3–4; на Фазе 1 фиксированный IP не обязателен, но большинство провайдеров дают его по умолчанию бесплатно).
2. Установить Node 22 LTS (ADR-001: библиотека `bybit-api` не декларирует `engines`, Node 24 никем не тестирован — держаться 22.x).
3. Установить Docker **только** для Postgres (ADR-004) либо поставить PostgreSQL 18 + TimescaleDB нативно — выбор за тем, кто разворачивает.
4. Создать системного пользователя не-root для процесса бота.

### systemd unit (ADR-005: systemd, не Docker/pm2, не `restart: always`)

```ini
# /etc/systemd/system/trade-bot-collector.service
[Unit]
Description=trade-bot market-data collector (Phase 1)
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=tradebot
WorkingDirectory=/opt/trade-bot
EnvironmentFile=/opt/trade-bot/.env
ExecStart=/usr/bin/node dist/collector.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

**`StartLimitIntervalSec`/`StartLimitBurst` — в `[Unit]`, не в `[Service]`.** На systemd 230+ (в т.ч. на Ubuntu 24.04, где реально разворачивался бот) это directive уровня unit'а — размещённые в `[Service]` они молча игнорируются (`Unknown key name ... ignoring` в журнале), и защита от restart-петли просто не работает, хотя сервис стартует без видимых ошибок. Поймано вживую при первом деплое на VPS 2026-08-06.

**`RestartSec=30` и `StartLimitBurst=5` — не значения по умолчанию, а осознанный выбор** (DECISIONS.md ADR-005): дефолтный `RestartSec` systemd — 100мс, и падающий процесс за минуту устроит сотни попыток переподключения к API. `StartLimitBurst=5` за `StartLimitIntervalSec=600` переводит юнит в `failed` после пяти падений за 10 минут вместо бесконечного цикла — тогда нужен человек, а не автоматика.

`.env` **не коммитится и не копируется через git** — переносится на сервер отдельно (`scp` напрямую в `/opt/trade-bot/.env` с правами `600`), значения вписываются или сверяются вручную.

Второй unit, killswitch-listener — та же дисциплина `RestartSec`/`StartLimitBurst`, но **не делит `EnvironmentFile` смысла ради изоляции**: оба процесса читают один и тот же `/opt/trade-bot/.env`, это нормально (не два разных набора секретов), просто разные `ExecStart`:

```ini
# /etc/systemd/system/trade-bot-killswitch-listener.service
[Unit]
Description=trade-bot kill switch listener (Level 1)
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=tradebot
WorkingDirectory=/opt/trade-bot
EnvironmentFile=/opt/trade-bot/.env
ExecStart=/usr/bin/node dist/killswitch-listener.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

**Почему это отдельный unit, а не поток внутри `trade-bot-collector`:** RR-31 буквально требует отдельный OS-процесс — если основной цикл зависнет (например, забытый таймаут на сокете), kill switch внутри того же процесса завис бы вместе с ним. Два независимых `systemctl`-юнита means один падает — второй продолжает следить.

### Первая выкладка

```bash
git clone https://github.com/SoftwareMaestro16/trade-bot.git /opt/trade-bot   # remote уже настроен, см. «Обновление кода на живом сервере» ниже
cd /opt/trade-bot
npm ci
npm run build
# .env скопировать отдельно, не через git
docker compose up -d              # если Postgres тоже на этом хосте
npm run migrate:up
sudo systemctl enable --now trade-bot-collector
```

### Обновление кода на живом сервере

**По факту (2026-08-07): `/opt/trade-bot` на VPS — не git-чекаут** (`.git` там нет). Код доставляется tar-синком с локальной машины, обычно по SSH под `root`:

```bash
# с локальной машины — .env НИКОГДА не синкать, продовый .env живёт только на VPS
tar czf - --exclude=node_modules --exclude=.git --exclude=dist --exclude=.env --exclude='.env.*' . | \
  ssh -i .deploy-keys/trade_bot_vps root@<VPS_IP> "tar xzf - -C /opt/trade-bot"

# на VPS — chown ПЕРЕД npm ci/build, рекурсивно, не только верхний каталог
chown -R tradebot:tradebot /opt/trade-bot
cd /opt/trade-bot
sudo -u tradebot npm ci
sudo -u tradebot npm run build
npm run migrate:up                # если есть новые миграции — см. раздел 5
sudo systemctl restart trade-bot-collector
sudo systemctl restart trade-bot-killswitch-listener
```

**Почему `chown -R` обязателен, не опционален, и почему именно в таком порядке**: `tar` на Windows/Git-Bash не имеет реального UID/GID-маппинга, поэтому `root`, распаковывая архив, создаёт всё дерево `/opt/trade-bot` с сырыми числовыми владельцами локальной машины — НЕ `tradebot`, от чьего имени реально работают оба systemd-юнита (`User=tradebot`). Два реальных инцидента 2026-08-07 (см. PHASE-LOG.md), не гипотетических:
1. Верхнеуровневый каталог достался чужому UID → `killswitch-listener`'s стартовый self-test (`killswitch/fileFlag.ts`) не смог создать `KILLSWITCH_STOP` (`EACCES`), корректно отказался стартовать (fail-closed), `StartLimitBurst=5` исчерпался — кильсвич уровня 1 пролежал недоступным **4 часа 43 минуты**.
2. Тем же днём, позже: `npm ci` от имени `tradebot` упал с `EACCES` на `rmdir` внутри `node_modules/.vite` — след более раннего запуска `npm ci`/`npm run build` от `root` без `sudo -u tradebot`, оставившего часть `node_modules` рут-владением.

Вывод: одного `chown` верхнего каталога после сборки недостаточно — нужен `chown -R` ДО любых `npm`-команд, И сами `npm ci`/`npm run build` должны запускаться явно от `tradebot` (`sudo -u tradebot`), а не «как получится», иначе следующий деплой снова испортит владение поддеревом `node_modules`/`dist`. `trade-bot-collector` не пострадал от инцидента №1 только потому, что не пишет новых файлов в верхний уровень каталога — это везение, не гарантия.

Remote уже настроен (`origin` → `https://github.com/SoftwareMaestro16/trade-bot.git`, локальный `master` отслеживает `origin/master`) — переключиться на `git clone`/`git pull` (см. ниже) можно уже сейчас, это не ждёт появления remote. Переключение снимает эту проблему полностью: `git pull`, выполненный от `tradebot`, никогда не тронет владельца каталога. Пока фактический деплой на VPS не переключён на `git pull` (см. «По факту» выше — `/opt/trade-bot` там до сих пор не git-чекаут), `chown` остаётся обязательным последним шагом любого tar-синк-деплоя, не «на будущее».

**Целевой процесс (доступен уже сейчас, просто ещё не принят как основной способ деплоя на VPS):**

```bash
cd /opt/trade-bot
git pull
npm ci
npm run build
npm run migrate:up                # если есть новые миграции — см. раздел 5
sudo systemctl restart trade-bot-collector
sudo systemctl restart trade-bot-killswitch-listener
```

**На Фазе 1 это безопасно в любой момент** — процесс не держит открытых позиций, рестарт максимум обрывает один цикл сбора (что попадёт в `collection_runs` как явный gap, FR-109). Это же не будет верно для `trader`-процесса в Фазах 4+ — там подряд рестарт с открытой позицией требует отдельной процедуры (SRS FR-306, ARCHITECTURE.md §4 `RECOVERY`), которая ещё не написана и будет отдельным разделом этого документа, когда появится код.

---

## 4. Мониторинг Фазы 1

**Настроено и подтверждено живым тестом (2026-08-07).** `src/collector.ts` пингует внешний heartbeat (`notify/healthcheck.ts`) на healthchecks.io — независимый канал от Telegram-дайджеста (если сам процесс/бот недоступен настолько, что не может прислать дайджест, он не может прислать и ЭТО — вот именно этот случай ловит внешний сервис). Настройка check'а: Period=5мин / Grace=15мин (см. RR-35, SRS.md). Обе интеграции healthchecks.io включены — email и Telegram (привязан напрямую через сайт healthchecks.io, не через `TELEGRAM_WATCHDOG_BOT_TOKEN` — см. этот параметр в `.env.example`, он зарезервирован на случай, если проект когда-нибудь будет слать watchdog-алерты сам, а не через встроенную интеграцию сервиса; сегодня им ничто не пользуется).

Это по-прежнему НЕ полная замена SRS RR-35 в исходном смысле (уровень 3 kill switch с собственным `watchdog/`-процессом на отдельном хосте, RISK-REGISTER.md AR-09) — heartbeat через сторонний SaaS ловит ровно один сценарий ("VPS/процесс полностью замолчал"), но не даёт того контроля над логикой алерта, что дал бы свой процесс. Для текущего масштаба (Фаза 1, ещё нет открытых позиций) этого достаточно.

Шаги для восстановления/пересоздания (если check когда-нибудь придётся переделать):

1. Завести бесплатный проект на healthchecks.io (или аналоге), получить ping URL.
2. Вписать его в `.env` на VPS как `HEALTHCHECK_PING_URL` (см. `.env.example`).
3. Перезапустить `trade-bot-collector` — при следующем старте лог покажет структурированную pino-строку с `"msg":"external heartbeat enabled"` (поля `task:"startup"`, `heartbeatIntervalMin:5`, `checks:[...]`) вместо `"external heartbeat disabled (HEALTHCHECK_PING_URL not set)"`. Логи — plain JSON на stdout (`src/logger.ts`), без префикса `[startup]` и без строки "every 5min" — интервал передаётся отдельным числовым полем. Проверить: `journalctl -u trade-bot-collector -n 50 --no-pager | grep 'external heartbeat enabled'`.
4. На странице check'а на healthchecks.io — Integrations → добавить Telegram (их собственный бот, привязка через переход по ссылке в диалоге интеграции, не требует своего токена).

Без `HEALTHCHECK_PING_URL` heartbeat просто не запускается (не ошибка, тихий no-op) — без него **единственный способ узнать, что сборщик упал, — зайти и проверить руками**:

```bash
sudo systemctl status trade-bot-collector
journalctl -u trade-bot-collector -n 100 --no-pager
```

### Проверка непрерывности (FR-109)

```sql
-- Циклы со статусом failed за последние сутки
SELECT id, status, started_at, finished_at, error
FROM collection_runs
WHERE status = 'failed' AND started_at > now() - interval '1 day'
ORDER BY started_at DESC;

-- Разрывы между тикер-циклами длиннее 3 минут (ожидаемый интервал — 1 минута)
SELECT started_at,
       started_at - lag(started_at) OVER (ORDER BY started_at) AS gap
FROM collection_runs
WHERE symbols_expected IS NOT NULL
ORDER BY started_at DESC
LIMIT 100;
```

Оба запроса — то, чем в конце Фазы 1 подтверждается exit criterion, а не декларируется на словах.

---

## 5. Миграции на живой БД

Правило из RISK-REGISTER.md FM-50, актуальное уже сейчас, хоть позиций ещё нет: миграции запускать **только** когда `collection_runs` не показывает `status='running'` (то есть между циклами сбора, не посреди одного). Для Фазы 1 это мягкая рекомендация ради целостности данных, не жёсткое требование безопасности — станет жёстким, когда появится `execution/` и открытые позиции (FM-50 целиком относится к этому будущему состоянию).

```bash
npm run migrate:up      # применить новые
npm run migrate:down    # откатить последнюю — только если БД пуста или откат безопасен
```

---

## 6. Архитектурная граница в CI

`eslint.config.js` проверяет NFR-11 автоматически: `strategy/` не может импортировать `exchange/` или `execution/` напрямую. Это работает уже сейчас, хотя `strategy/` пока пуст — правило готово сработать с первого файла, который там появится.

```bash
npm run lint
```

Провал этой проверки в CI блокирует мердж, не просто предупреждает — `.github/workflows/ci.yml` уже настроен (checkout → Node 22 → `npm ci` → typecheck → lint → `node-pg-migrate up` против реального Postgres в service-контейнере → `npm test`), запускается на каждый push/PR в `master`.

---

## 7. Бэкапы

**Настроено и работает** (VPS-деплой 2026-08-06, 139.162.24.37). Ежедневный `pg_dump`, cron на самом VPS:

```bash
# /root/backup-trade-bot-db.sh, cron: 17 3 * * * /root/backup-trade-bot-db.sh
docker exec trade-bot-postgres pg_dump -U user -d trade_bot | gzip > "$BACKUP_DIR/trade_bot_$STAMP.sql.gz"
```

Хранит последние 14 копий (`ls -1t ... | tail -n +15 | xargs rm`), лежат в `/root/backups/` на самом VPS. Это заменяет платный Linode Backups ($5/мес) — тот же результат, без подписки.

**Важно: это план "Б", не единственная копия.** Бэкапы лежат на ТОМ ЖЕ диске, что и сама БД — если сгорит весь VPS (не только контейнер), эти 14 копий сгорят вместе с ним. Объектное хранилище отдельного провайдера (PARAMS-CONSERVATIVE.md) всё ещё открытый пункт — ниже описан только "скачать вручную", не автоматическая репликация off-VPS.

**Скачать бэкап к себе на локальную машину:**
```bash
scp -i .deploy-keys/trade_bot_vps root@<VPS_IP>:/root/backups/trade_bot_<STAMP>.sql.gz ./backups/
```
Проверено вживую 2026-08-06 — реальный дамп (128MB на тот момент) скачан без проблем.

**Сделать дамп прямо сейчас (не ждать 03:17 UTC) и сразу скачать:**
```bash
ssh -i .deploy-keys/trade_bot_vps root@<VPS_IP> /root/backup-trade-bot-db.sh
```
— затем `scp` как выше, файл появится в `/root/backups/` с текущим таймстампом.

**Восстановить в ЛЮБУЮ другую Postgres/TimescaleDB (не обязательно на том же VPS, не обязательно у того же провайдера)** — обычный `pg_dump`-формат, никакой привязки к Linode:
```bash
gunzip -c trade_bot_<STAMP>.sql.gz | docker exec -i <новый_контейнер> psql -U user -d trade_bot
```
Именно так и переносились локально собранные данные на этот VPS при первом деплое (только не из файла, а напрямую через pipe между контейнерами) — процедура уже проверена на реальных ~2GB данных, а не только в теории.

**Офсайт-копия в объектное хранилище — скрипт готов, провайдер ещё не выбран.**

`scripts/push-backup-offsite.sh` (в репозитории, не на VPS) закрывает разрыв из абзаца выше «план "Б"»: вторым шагом после `/root/backup-trade-bot-db.sh` копирует последний `trade_bot_*.sql.gz` из `/root/backups/` в S3-совместимый бакет через `rclone copy` (не `sync` — умышленно, `sync` умеет удалять в бакете файлы, которых нет в источнике; обоснование подробно в комментарии самого скрипта). Провайдер-агностичный: Backblaze B2, Wasabi, AWS S3, Linode Object Storage — что угодно с S3 API, имя remote и путь бакета передаются аргументами/переменными окружения, ничего не захардкожено.

```bash
# на VPS, вторым шагом после дампа
./push-backup-offsite.sh <remote-name> <bucket-path>
# или
RCLONE_REMOTE=<remote-name> RCLONE_BUCKET_PATH=<bucket-path> ./push-backup-offsite.sh
```

**Единственный оставшийся шаг — ручной, одноразовый, требует человека с реальными кредами провайдера (не автоматизируется):**
1. Выбрать провайдера объектного хранилища — ДРУГОЙ провайдер/регион, чем сам VPS (Linode), иначе смысл теряется (см. также OPEN-QUESTIONS.md §14).
2. На VPS: `curl https://rclone.org/install.sh | sudo bash`, затем `rclone config` — интерактивно, реальные креды выбранного провайдера, дать remote имя (например `b2-backup`).
3. **Проверка перед тем, как полагаться на скрипт:** `rclone lsd <remote-name>:` должно отработать без ошибки. Затем один раз руками: `./push-backup-offsite.sh <remote-name> <bucket-path>`, проверить `echo $?` (0 — успех) и глазами убедиться, что файл появился в бакете (веб-консоль провайдера или `rclone lsf <remote-name>:<bucket-path>`). Запустить второй раз подряд — должно снова завершиться 0 без ошибок и без дублей (скрипт идемпотентен, `rclone copy` не трогает уже совпадающий файл в бакете).
4. Добавить второй командой в существующий cron: `17 3 * * * /root/backup-trade-bot-db.sh && /root/push-backup-offsite.sh <remote-name> <bucket-path> >> /root/backups/push-backup-offsite.log 2>&1`.

До выполнения этого шага абзац выше («Важно: это план "Б", не единственная копия») остаётся в силе как есть — офсайт-копии физически ещё нет, только готовый к использованию инструмент.

---

## 8. Чего в этом RUNBOOK намеренно нет

Раздел существует, чтобы не создавалось впечатление полноты там, где её нет:

- **Kill switch — уровни 2 и 3, раздел 7 брифа.** Уровень 1 (файл-флаг + Telegram, полный список команд и inline-кнопки — см. раздел 2 выше) уже написан, протестирован и описан в разделе 2 выше. Уровень 2 (автоматические триггеры — просадка, `accountMMRate`, потеря WS-соединения) не написан. Уровень 3 (внешний watchdog-хост, RR-35) не написан. И ни один уровень пока не может физически ничего закрыть на бирже — `execution/` не размещает ордеров.
- **Процедура инцидента с открытой позицией.** Неприменимо — позиций не существует до Фазы 4.
- **Ротация логов / структурированное логирование (pino, ADR-005).** ~~Сейчас `console.log`/`console.error` на stdout/stderr, journald их собирает без ротации на уровне приложения. Смена на pino — точечное улучшение, не блокирует Фазу 1.~~ **Сделано (2026-08-07):** `console.*` в `src/collector.ts`, `src/killswitch-listener.ts` и `src/market-data/**` заменены на pino (`src/logger.ts`, plain JSON-строки на stdout — без pretty-print, journald по-прежнему собирает вывод без ротации на уровне приложения, это не изменилось). Каждый модуль пишет через свой дочерний логгер (`logger.child({ module: "..." })`) вместо ручного префикса `[module] ...`. `src/notify/telegram.ts`/`telegramPolling.ts` намеренно не тронуты — их `console.error` уже сознательно логируют только `.message`, никогда сырой объект ошибки (там может быть токен бота), это осталось как есть.
- **CI-пайплайн.** ~~OPEN-05 в SRS §7 — открытый параметр, ответ за владельцем.~~ **Сделано:** `.github/workflows/ci.yml` — typecheck/lint/migrate/test на каждый push/PR в `master`, см. раздел 6 выше. (OPEN-05 в SRS §7 — отдельный, до сих пор открытый параметр: точный набор Telegram-команд сверх `/stop`/`/status`/`/resume`; список команд теперь на практике шире и уже задокументирован в разделе 2 выше, SRS стоит свериться отдельно.)
