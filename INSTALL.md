# 🦆 Установка Tortuga Duck — пошагово, с нуля

Инструкция рассчитана на человека, который ни разу не работал с терминалом.
Команды из серых блоков копируй целиком и вставляй как есть.
Займёт примерно 40–60 минут, всё бесплатно.

---

## Шаг 1. Создаём бота в Discord

1. Открой https://discord.com/developers/applications и войди.
2. **New Application** → название `Tortuga Duck` → Create.
3. На вкладке **General Information** скопируй **Application ID** и сохрани в блокнот: это `CLIENT_ID`.
4. Вкладка **Bot**:
   - Загрузи аватар и баннер, можно GIF. Если портал не примет GIF, напиши мне, есть другой способ.
   - Нажми **Reset Token**, скопируй токен и сохрани. Это `DISCORD_TOKEN`.
     ⚠️ Токен — пароль бота. Никому его не показывай и никуда не пиши, кроме файла `.env` на сервере.
   - Ниже, в разделе **Privileged Gateway Intents**, включи **Server Members Intent** и нажми Save.
5. Пригласи бота на сервер. Открой ссылку, подставив свой Application ID:
   ```
   https://discord.com/oauth2/authorize?client_id=ТВОЙ_CLIENT_ID&scope=bot+applications.commands&permissions=288738320
   ```
   Выбери свой сервер → Авторизовать.
6. Узнай ID сервера. Discord → Настройки → Расширенные → включи **Режим разработчика**.
   Потом ПКМ по иконке сервера → **Копировать ID сервера**. Это `GUILD_ID`.
7. Настройки сервера → **Роли**. Перетащи роль **Tortuga Duck** выше всех ролей, которые бот должен выдавать.
   Иначе он не сможет их назначать.

---

## Шаг 2. Бесплатный сервер в Oracle Cloud

1. Зарегистрируйся: https://www.oracle.com/cloud/free/
   - Понадобится банковская карта для проверки. Деньги не списывают, только временно блокируют небольшую сумму.
   - **Home Region** выбери Европу, например Germany Central (Frankfurt). Потом регион не поменять.
2. В консоли: **Compute → Instances → Create instance**.
   - **Image**: Canonical **Ubuntu 24.04**.
   - **Shape** → Change shape → **Ampere** → `VM.Standard.A1.Flex`, **2 OCPU, 12 GB**. Это максимум бесплатного.
   - **Add SSH keys** → **Generate a key pair for me** → **Save private key**.
     Сохрани файл, например в `C:\Users\ТВОЁ_ИМЯ\oracle.key`. Без него на сервер не попасть.
   - Нажми **Create**.
   - Если пишет *Out of capacity*: в популярных регионах бесплатных ARM иногда не хватает. Попробуй через пару часов или выбери другой Availability Domain.
3. Когда сервер запустится, скопируй его **Public IP address**.

---

## Шаг 3. Подключаемся к серверу

На Windows 10/11 открой **PowerShell** (Пуск → PowerShell) и выполни, подставив путь к ключу и IP:
```
ssh -i C:\Users\ТВОЁ_ИМЯ\oracle.key ubuntu@IP_СЕРВЕРА
```
На вопрос `Are you sure you want to continue connecting` напиши `yes`.
Если ругается на права ключа (`UNPROTECTED PRIVATE KEY FILE`), выполни в PowerShell и подключись снова:
```
icacls C:\Users\ТВОЁ_ИМЯ\oracle.key /inheritance:r /grant:r "$($env:USERNAME):(R)"
```
Когда увидишь строку вида `ubuntu@...:~$`, ты на сервере.

---

## Шаг 4. Ставим Docker (один раз)

Вставь по очереди:
```
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```
Подключись снова командой `ssh` из шага 3. Проверь, что Docker работает:
```
docker run --rm hello-world
```
Должно появиться `Hello from Docker!`.

---

## Шаг 5. Скачиваем бота и вписываем настройки

```
git clone https://github.com/ТВОЙ_НИК/tortuga-duck.git
cd tortuga-duck
cp .env.example .env
nano .env
```
Откроется редактор. Заполни `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`.
В `LAVALINK_PASSWORD` придумай любой длинный пароль.
Сохранить: **Ctrl+O**, потом **Enter**. Выйти: **Ctrl+X**.

> Если репозиторий приватный, `git clone` спросит логин и пароль.
> Вместо пароля нужен токен: GitHub → Settings → Developer settings → Personal access tokens.

---

## Шаг 6. Запуск

```
docker compose up -d --build
```
Первый раз сборка займёт несколько минут. Посмотреть логи бота:
```
docker compose logs -f bot
```
Ждём строки `Вошёл как Tortuga Duck#...` и `Lavalink подключён`. Выйти из логов: **Ctrl+C**, бот продолжит работать.

---

## Шаг 7. Настройка в Discord

Создай нужные каналы и выполни на сервере команды (они видны только админам):

| Что | Команда |
|---|---|
| Приветствия | `/setup channel purpose:Приветствия новичков channel:#welcome` |
| Панель ролей | `/setup channel purpose:Выбор ролей channel:#роли` |
| Join to Create | `/setup channel purpose:Join to Create channel:🔊 Создать канал` |
| Панель приваток | `/setup channel purpose:Управление приватными каналами channel:#create_private_vc` |
| Плеер | `/setup channel purpose:Плеер музыки channel:#музыка` |
| Новости | `/setup channel purpose:Новости: игры channel:#игровые-новости` (и так для остальных) |
| Базовая роль | `/setup role purpose:Базовая роль role:@Житель` |
| Роль DJ | `/setup role purpose:DJ role:@DJ` |
| DJ-режим | `/setup djmode enabled:True` или `False` |
| Проверить всё | `/setup show` |

Полезно знать:
- **Join to Create** — голосовой канал, лучше в отдельной категории. Приватки создаются в той же категории.
- **Новостные каналы по ролям.** Бот сам создаст роли `Новости: Игры`, `Новости: Кино` и т. д., когда кто-то их выберет.
  Чтобы канал видели только подписавшиеся: настройки канала → Права → у @everyone запрети «Просматривать канал», у нужной роли разреши.
- **Вопросы при входе на сервер.** Включи встроенный Discord Onboarding: Настройки сервера → **Онбординг**.
  Нужен «Сервер сообщества», он включается там же. Добавь вопрос «Какие новости показывать?» с теми же ролями `Новости: …`.
  Бот всё равно выдаёт базовую роль всем и держит панель `/roles`, чтобы выбор можно было поменять позже.
- Проверить приветствие: `/welcome-test`. Проверить новости сразу: `/news-now`.

---

## Шаг 8. Свои картинки, фразы и ленты

Всё лежит в папках на сервере, пересобирать бота не нужно:
- `assets/ducks/` — картинки утки, `assets/welcome/` — фоны карточки.
- `config/welcome.json` — фразы приветствий (`{user}` — упоминание, `{name}` — ник).
- `config/roles.json` — группы ролей для чеклиста.
- `config/feeds.json` — RSS-ленты новостей.
  Чтобы добавить публичный Telegram-канал, впиши ленту вида
  `{ "name": "Название", "url": "http://rsshub:1200/telegram/channel/ТЕГ_КАНАЛА" }`.
  Тег пишется без `@`. Канал должен быть публичным: у него открывается страница `t.me/s/ТЕГ`.

Залить картинку с компьютера на сервер (в PowerShell на своём ПК, не на сервере):
```
scp -i C:\Users\ТВОЁ_ИМЯ\oracle.key C:\путь\duck1.png ubuntu@IP_СЕРВЕРА:~/tortuga-duck/assets/ducks/
```
Править конфиг на сервере: `nano config/feeds.json`.

---

## Обновление бота

```
cd ~/tortuga-duck
git pull
docker compose up -d --build
```

## Если что-то не работает

- `docker compose ps` — оба контейнера (`bot` и `lavalink`) должны быть `running`.
- `docker compose logs --tail 100 lavalink` — логи аудиосервера.
  Если Lavalink падает из-за Spotify: открой `nano lavalink/application.yml`, поставь `spotify: false`, затем `docker compose restart lavalink`.
- Команды не появились в Discord — проверь `GUILD_ID` и перезапусти: `docker compose restart bot`.
- Бот не выдаёт роли — его роль должна стоять выше этих ролей (шаг 1, пункт 7).
