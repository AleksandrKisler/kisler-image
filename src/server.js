const { createApp } = require("./app");

const port = process.env.PORT || 8080;
const app = createApp();

app.listen(port, () => {
    console.log("[api] listening on", port);
});
