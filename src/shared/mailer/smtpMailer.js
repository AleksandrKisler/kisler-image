const nodemailer = require("nodemailer");
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
async function sendOtpEmail({ to, code }) {
  await t.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: "OTP Code",
    html: `<h1>${code}</h1>`
  });
}
module.exports = { sendOtpEmail };
