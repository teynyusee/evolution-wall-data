const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const app = express();

/* =========================
   BASIS MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json());

/* =========================
   STATIC FILES (uploads)
========================= */
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));


/* =========================
   DATA LOADER (species)
========================= */
function loadSpeciesData() {
  const filePath = path.join(__dirname, "data", "species.json");
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

/* =========================
   SPECIES ROUTES
========================= */

// Alle species
app.get("/api/v1/species", (req, res) => {
  res.json(loadSpeciesData());
});

// Species per ID
app.get("/api/v1/species/:id", (req, res) => {
  const data = loadSpeciesData();
  const id = Number(req.params.id);

  const item = data.species.find(s => s.id === id);
  if (!item) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(item);
});

/* =========================
   PHOTO UPLOAD (MULTER)
========================= */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "uploads/photos"));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    const filename = `photo_${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({ storage });

// Foto uploaden
app.post("/api/v1/photos", upload.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo uploaded" });
  }

  const speciesId = req.body.speciesId || null;

  res.json({
    id: req.file.filename,
    speciesId,
    url: `/uploads/photos/${req.file.filename}`
  });
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (req, res) => {
  res.send("ok");
});

/* =========================
   SERVER START
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Evolution Wall API running on port", PORT);
});
