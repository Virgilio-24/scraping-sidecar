import express from "express";
import { config } from "./config.js";
import routes from "./routes/index.js";

const app = express();

app.use(express.json());
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    name: "shein-scraping-sidecar",
    status: "ok",
  });
});

app.listen(config.port, () => {
  console.log(`Server is running on port ${config.port}`);
});
