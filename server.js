const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

function loadSpeciesData() {
  const filePath = path.join(__dirname, "data", "species.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

app.get("/api/v1/species", (req, res) => {
  res.json(loadSpeciesData());
});

app.get("/api/v1/species/:id", (req, res) => {
  const data = loadSpeciesData();
  const id = Number(req.params.id);

  const item = data.species.find(s => s.id === id);
  if (!item) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(item);
});

app.get("/health", (req, res) => {
  res.send("ok");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Evolution Wall API running on port", PORT);
});
