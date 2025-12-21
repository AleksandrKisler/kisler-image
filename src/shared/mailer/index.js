module.exports =
  process.env.MAILER_MODE === "smtp"
    ? require("./smtpMailer")
    : require("./devMailer");
