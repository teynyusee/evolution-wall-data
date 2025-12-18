const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

function loadData() {
  const p = path.join(__dirname, "data", "species.json");
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

app.get("/api/v1/species", (req, res) => {
  res.json(loadData());
});

app.get("/api/v1/species/:id", (req, res) => {
  const data = loadData();
  const item = data.species.find(s => s.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  res.json(item);
});

app.get("/health", (req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("API running on", PORT));
