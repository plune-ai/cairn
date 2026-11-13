# Тестова пошта і TOTP у браузерних сценаріях

Дизайн — [ADR-0023](adr/0023-test-mailbox-and-totp.md). Можливість **вимкнена за замовчуванням**: без сесії
`MailboxSession` жоден запуск не змінюється.

## Налаштування (лише змінні середовища)

| Змінна | Обовʼязкова | Значення |
|---|---|---|
| `MAILSAC_API_KEY` | так | Ключ Mailsac. Йде лише в заголовок `Mailsac-Key`; у логах, помилках і звітах його немає. |
| `MAILSAC_ADDRESS` | ні | Фіксована адреса. Без неї кожен прогін отримує свою: `cairn-<runId>-<12 hex>@<домен>`. |
| `MAILSAC_DOMAIN` | ні | Домен згенерованих адрес, типово `mailsac.com`. Для листів з персональними даними — приватний домен. |

Ім'я змінної із секретом TOTP (наприклад `TOTP_SECRET`, base32) задається у кроці; значення в сценарій не потрапляє.

## Кроки

| Крок | Що робить | Що повертає |
|---|---|---|
| `mailbox.create` | створює адресу на прогін | `{{mailbox.address}}` |
| `mailbox.waitFor` (`subject`, `from`, `timeoutMs`) | опитує скриньку, поки не прийде лист (найновіший збіг); типово 60 с / 3 с | помилка по таймауту, без вмісту листів |
| `mailbox.extractLink` (`contains`) | перше `http(s)`-посилання, або перше з підрядком | `{{mailbox.link}}` |
| `mailbox.extractCode` (`pattern`, `length`) | окреме число з `length` цифр (типово 6) або перша група виразу | `{{mailbox.code}}` |
| `mailbox.openLink` | відкриває посилання в браузері (`navigate` через `BrowserGateway`) | `link opened` |
| `totp.code` (`secretEnv`) | код RFC 6238; на межі 30-секундного вікна чекає наступного | `{{totp.code}}` |

Крок повертає лише покажчик (`link found`, `code generated`). Значення виконавець підставляє пізно, через
`session.resolve("… {{mailbox.code}} …")`, і лише у `fill`/`navigate`.

```ts
import { MailboxSession, mailsacFromEnv } from "@plune-ai/cairn";

const mail = new MailboxSession({ provider: mailsacFromEnv(), runId });
try {
  await mail.run({ action: "mailbox.create" });
  // ... fill "Email" з mail.resolve("{{mailbox.address}}") ...
  await mail.run({ action: "mailbox.waitFor", subject: "Підтвердіть", from: "noreply@" });
  await mail.run({ action: "mailbox.extractLink", contains: "/verify" });
  await mail.run({ action: "mailbox.openLink" }, gateway);
} finally {
  await mail.cleanup(); // також при падінні
}
```

Передайте ту саму сесію в `ExploreInput.mailbox`: усі адреси, посилання, коди й секрет TOTP будуть замасковані в
прогрес-рядках, `run.log` і текстах помилок валідації (той самий `redact()`, що й для оточення).

## Сценарії

**Реєстрація з посиланням підтвердження.** `mailbox.create` → заповнити «Email» адресою → `mailbox.waitFor`
(`subject: "Підтвердіть"`) → `mailbox.extractLink` (`contains: "/verify"`) → `mailbox.openLink` → перевірити, що
користувач увійшов.

**Скидання пароля.** `mailbox.create` (адреса вже зареєстрованого акаунта — або `MAILSAC_ADDRESS`) → «Забули
пароль» з цією адресою → `mailbox.waitFor` (`subject: "Скидання"`) → `mailbox.extractLink` → `mailbox.openLink` →
ввести новий пароль зі змінної середовища.

**Код 2FA.** Із застосунку-аутентифікатора: `totp.code` (`secretEnv: "TOTP_SECRET"`) → заповнити поле коду
`{{totp.code}}`. З листа: `mailbox.waitFor` → `mailbox.extractCode` → заповнити `{{mailbox.code}}`.

## Коли кроки додає сам агент

Якщо в `ExploreInput.mailbox` (або в `mailbox` у `runAutomate`) передано сесію, агент сам вирішує, де потрібні ці
кроки, за правилом `mailboxNeed` (ADR-0023, розділ 4), а не за відповіддю моделі. Ознаки:

| Ознака | Приклад | Кроки |
|---|---|---|
| Текст сторінки каже, що лист надіслано | «Check your email», «We've sent a confirmation link», «Перевірте пошту», «Ми надіслали вам лист» | `mailbox.create` → `mailbox.waitFor` → `mailbox.extractLink` → відкрити посилання |
| Те саме, і на сторінці є поле для коду | «Verify your email» + поле «Verification code» | `mailbox.create` → `mailbox.waitFor` → `mailbox.extractCode` |
| Крок кейсу називає лист чи код з нього | «Open the confirmation link from the email», «Ввести код з листа» | як вище: посилання або код |
| Поле просить одноразовий код, листа не згадано | «Authentication code», «Two-factor authentication», «2FA code» | `totp.code` |

Не ознака: «Promo code», «Postal code», купон, знижка, поле «Email» у формі входу, крок «Fill Email with a valid
address». Ім'я змінної із секретом TOTP — `totpSecretEnv` у `MailboxSession` (типово `TOTP_SECRET`).

Без сесії агент цих кроків не додає й полів не заповнює; на сторінці з ознакою він пише один рядок прогресу
(«needs e-mail/OTP, and the mailbox steps are off»), а в результаті `runExploreGraph` це поле `mailbox` без `steps`.

## Що потрапляє в згенерований тест

Поруч зі специфікаціями записується `mailbox.fixture.ts`; специфікації імпортують `test` і `expect` з нього й беруть
фікстуру `mail` (своя `MailboxSession` на тест, `cleanup` після нього, також при падінні):

```ts
import { test, expect } from './mailbox.fixture';

test('sign-up confirms the e-mail', async ({ page, mail }) => {
  await mail.run({ action: 'mailbox.create' });
  await page.getByLabel('Email', { exact: true }).fill(mail.resolve('{{mailbox.address}}'));
  // ...
  await mail.run({ action: 'mailbox.waitFor' });
  await mail.run({ action: 'mailbox.extractLink' });
  await page.goto(mail.resolve('{{mailbox.link}}'));
});
```

Значень у файлах немає: `MAILSAC_API_KEY` (і `MAILSAC_ADDRESS`, `MAILSAC_DOMAIN`) та змінна з секретом TOTP читаються з
середовища за іменем під час прогону; Mailsac потрібен лише тестам, що читають пошту. Згенерований файл, у якому
трапилося значення ключа, секрету, адреси, посилання чи коду, не записується. Фікстура імпортує `@plune-ai/cairn`, тож
пакет має бути встановлений там, де запускаються тести.

## `cairn doctor`

Розділ «Test mailbox» показує, чи задано `MAILSAC_API_KEY` (саме значення — ніколи), домен адрес (публічний
`mailsac.com` позначено попередженням) і відповідь Mailsac на одне читання скриньки на цьому домені: `✓ … key accepted`,
або `✗` з HTTP-статусом (наприклад `401 - check MAILSAC_API_KEY`), без ключа й адреси.

## Чого немає

SMS, push, passkeys, CAPTCHA і реальні скриньки людей не підтримуються (див. ADR-0023, розділ 5).
