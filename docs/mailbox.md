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

## Чого немає

SMS, push, passkeys, CAPTCHA і реальні скриньки людей не підтримуються (див. ADR-0023, розділ 5). Агент поки не
вирішує сам, коли викликати ці кроки: їх викликає виконавець сценарію.
