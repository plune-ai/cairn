# Опис оточення: Basic Auth → логін → шлях старту

Браузерні потоки Cairn (`explore`, `design`, `automate --validate`) можуть підготувати застосунок самі, у фіксованому
порядку:

1. **Basic Auth** — якщо задано `basicAuth`;
2. **логін** користувачем зі змінних середовища — якщо задано `user`;
3. **перехід на `startPath`** — якщо задано;
4. **кроки сценарію** — звичайний запуск, уже з готовою сесією.

Етап без вхідних даних пропускається (у журналі буде рядок `environment <етап>: skipped (...)`). Нічого «підкидати» у
застосунок не потрібно, а облікові дані лишаються у вашому CI: у файлі — лише **імена** змінних.

## Файл опису

`cairn.env.json` (назва довільна, передається через `--env-file`):

```json
{
  "baseUrl": "https://staging.example.com",
  "basicAuth": { "usernameVar": "STAGING_BASIC_USER", "passwordVar": "STAGING_BASIC_PASS" },
  "user": {
    "usernameVar": "STAGING_QA_USER",
    "passwordVar": "STAGING_QA_PASS",
    "loginPath": "/login"
  },
  "startPath": "/dashboard"
}
```

| Поле | Обовʼязкове | Значення |
|---|---|---|
| `baseUrl` | так | Адреса оточення, без логіна й пароля в URL. |
| `basicAuth.usernameVar`, `.passwordVar` | ні | **Імена** змінних середовища з логіном і паролем Basic Auth. |
| `user.usernameVar`, `.passwordVar` | ні | **Імена** змінних із логіном і паролем користувача застосунку. |
| `user.loginPath` | ні | Сторінка з формою входу, за замовчуванням `/login`. |
| `user.usernameLabel`, `.passwordLabel`, `.submitLabel` | ні | Доступні назви полів і кнопки, якщо типові (`user`/`email`/`login`, `pass`, `sign in`/`log in`/`submit`) не підходять. |
| `startPath` | ні | Шлях, з якого стартує запуск. |

Файл відхиляється, якщо в ньому є невідомий ключ (наприклад `password` чи `token`) або значення, що не схоже на ім'я
змінної, — пароль у файл потрапити не може.

## Змінні середовища

Ті самі поля можна задати без файла (вони також перекривають значення з файла):

| Змінна | Поле |
|---|---|
| `CAIRN_ENV_FILE` | шлях до файла (замість `--env-file`) |
| `CAIRN_ENV_BASE_URL` | `baseUrl` |
| `CAIRN_ENV_START_PATH` | `startPath` |
| `CAIRN_ENV_BASIC_AUTH_USER_VAR`, `CAIRN_ENV_BASIC_AUTH_PASSWORD_VAR` | `basicAuth` |
| `CAIRN_ENV_USER_VAR`, `CAIRN_ENV_PASSWORD_VAR` | `user.usernameVar`, `user.passwordVar` |
| `CAIRN_ENV_LOGIN_PATH` | `user.loginPath` |

## Запуск

```bash
export STAGING_BASIC_USER=…  STAGING_BASIC_PASS=…   # у CI — зі сховища секретів
export STAGING_QA_USER=…     STAGING_QA_PASS=…

cairn explore  --env-file cairn.env.json                # --url не потрібен: старт з baseUrl + startPath
cairn design   --env-file cairn.env.json
cairn automate --run <id> --validate --env-file cairn.env.json
```

Явний `--url` має пріоритет над `baseUrl + startPath`: етапи оточення все одно виконуються, а дослідження починається з
`--url`. Без `--env-file` і без `CAIRN_ENV_*` поведінка не змінюється, старі команди й конфіги працюють як раніше.

Для `automate --validate` Basic Auth потрапляє в згенерований `playwright.config.cjs` як `process.env["…"]` (значень там
немає), а сесія після логіну передається прогону через тимчасовий файл, який видаляється при завершенні процесу.

## Три різні помилки

| Етап | Повідомлення починається з | Типова причина |
|---|---|---|
| Basic Auth | `Basic Auth rejected` | Сервер відповів 401 на облікові дані зі змінних. |
| Логін | `Login failed` | Форми немає, поля не заповнились або після відправки форма лишилась на екрані. |
| Шлях старту | `Start page unreachable` | Сервер не відповів або віддав HTTP 4xx/5xx для `startPath`. |

Некоректний опис (зайвий ключ, незадана змінна) дає окрему помилку `EnvironmentConfigError` з іменем змінної, але без
значення.

## Секрети

- Значення читаються лише зі змінних середовища.
- У журналі запуску, прогрес-повідомленнях, помилках етапів і текстах помилок валідації значення секретів замінюються на
  `[REDACTED]`. Повідомлення етапів додатково маскують шаблони `password=…`, `token: …`, `otp=…`, заголовок
  `Authorization` і `user:pass@` в URL.
- Файл опису з секретом відхиляється (див. вище).

## Обмеження

- Basic Auth і логін потребують бекенда `lib` (типовий). З `--backend cli` така комбінація відхиляється з поясненням.
- Логін — проста форма «поле логіна, поле пароля, кнопка». Вхід через OAuth, лист-посилання чи одноразовий код цим
  описом не покривається — для нього лишається збережена сесія ([`sessions.md`](./sessions.md)).
- Якщо задано `--session`/`--session-file`, етап логіну пропускається: збережена сесія головніша.
