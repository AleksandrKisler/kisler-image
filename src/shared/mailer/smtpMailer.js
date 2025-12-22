const nodemailer = require("nodemailer");
const t = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: {user: process.env.SMTP_USER, pass: process.env.SMTP_PASS}
});

async function sendOtpEmail({to, code}) {
    const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Kisler Photo — код входа</title>
</head>
<body style="margin:0; padding:0; background-color:#f7f5f2; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7f5f2; padding:32px 0;">
    <tr>
      <td align="center">

        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px; background:#ffffff; border-radius:24px; box-shadow:0 10px 30px rgba(0,0,0,0.06); overflow:hidden;">
          <tr>
            <td style="padding:32px 32px 16px 32px;">
              <div style="font-size:22px; font-weight:600; color:#1c1917;">
                Kisler Photo
              </div>
              <div style="margin-top:8px; font-size:14px; color:#78716c;">
                Оживляем фотографии
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 32px 0 32px;">
              <h1 style="margin:0; font-size:26px; font-weight:500; color:#1c1917;">
                Ваш код входа
              </h1>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 32px 0 32px;">
              <p style="margin:0; font-size:15px; line-height:1.6; color:#44403c;">
                Используйте этот код, чтобы войти в сервис и продолжить работу с фотографиями.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:28px 32px;">
              <div style="
                display:inline-block;
                padding:18px 32px;
                background:#1c1917;
                color:#ffffff;
                font-size:32px;
                letter-spacing:6px;
                border-radius:999px;
                font-weight:600;
              ">
                ${code}
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px 24px 32px;">
              <p style="margin:0; font-size:14px; color:#78716c;">
                Код действует ограниченное время. Если вы не запрашивали вход — просто проигнорируйте это письмо.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px;">
              <div style="height:1px; background:#e7e5e4;"></div>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px 32px 32px;">
              <p style="margin:0; font-size:12px; color:#a8a29e; line-height:1.5;">
                Kisler Photo · AI-анимация портретов<br/>
                Если возникли вопросы — просто ответьте на это письмо
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>
  `;

    await t.sendMail({
        from: process.env.MAIL_FROM,
        to,
        subject: "Код входа в Kisler Photo",
        html,
        text: `Kisler Photo\n\nВаш код входа: ${code}\n\nЕсли вы не запрашивали вход — просто проигнорируйте это письмо.`,
    });
}

module.exports = {sendOtpEmail};
