async function sendOtpEmail({ to, code }) {
  console.log("OTP:", to, code);
}
module.exports = { sendOtpEmail };
