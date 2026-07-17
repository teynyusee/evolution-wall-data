"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const QRCode = require("qrcode");

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const app = express();

/* =========================================================
   CONFIGURATIE
========================================================= */

const PORT = Number(process.env.PORT) || 3000;

/*
 * Voor lokaal testen:
 * http://localhost:3000
 *
 * Voor een gsm op hetzelfde netwerk:
 * bijvoorbeeld http://192.168.1.50:3000
 *
 * Voor productie:
 * bijvoorbeeld https://museum.example.be
 */
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const PHOTO_LIFETIME_HOURS = Number(
  process.env.PHOTO_LIFETIME_HOURS || 1
);

const MAX_PHOTO_SIZE_BYTES = 15 * 1024 * 1024;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const SPECIES_JSON_PATH = path.join(DATA_DIR, "species.json");
const PHOTOS_JSON_PATH = path.join(DATA_DIR, "photos.json");

const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");
const PHOTO_UPLOAD_DIR = path.join(UPLOADS_DIR, "photos");
const QR_UPLOAD_DIR = path.join(UPLOADS_DIR, "qr");

/* =========================================================
   BASISMIDDLEWARE
========================================================= */

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  })
);

/*
 * Alles in public/ wordt bereikbaar via de browser.
 *
 * Voorbeelden:
 * public/uploads/photos/test.png
 * wordt:
 * http://localhost:3000/uploads/photos/test.png
 */
app.use(express.static(PUBLIC_DIR));

/* =========================================================
   INITIALISATIE
========================================================= */

function createInitialPhotosData() {
  return {
    version: 1,
    photos: [],
  };
}

async function ensureProjectFiles() {
  await Promise.all([
    fsp.mkdir(DATA_DIR, { recursive: true }),
    fsp.mkdir(PUBLIC_DIR, { recursive: true }),
    fsp.mkdir(PHOTO_UPLOAD_DIR, { recursive: true }),
    fsp.mkdir(QR_UPLOAD_DIR, { recursive: true }),
  ]);

  try {
    await fsp.access(PHOTOS_JSON_PATH);
  } catch {
    await writeJsonSafely(
      PHOTOS_JSON_PATH,
      createInitialPhotosData()
    );
  }
}

/* =========================================================
   JSON HELPERS
========================================================= */

async function readJsonFile(filePath, fallbackValue) {
  try {
    const content = await fsp.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    console.error(`Kon JSON-bestand niet lezen: ${filePath}`);
    throw error;
  }
}

/*
 * Eerst naar een tijdelijk bestand schrijven en daarna
 * hernoemen. Zo wordt de kans kleiner dat photos.json
 * halfgeschreven achterblijft.
 */
async function writeJsonSafely(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  await fsp.writeFile(temporaryPath, json, "utf8");
  await fsp.rename(temporaryPath, filePath);
}

async function loadPhotosData() {
  const data = await readJsonFile(
    PHOTOS_JSON_PATH,
    createInitialPhotosData()
  );

  if (!data || !Array.isArray(data.photos)) {
    throw new Error(
      "data/photos.json heeft niet de verwachte structuur."
    );
  }

  return data;
}

async function savePhotosData(data) {
  await writeJsonSafely(PHOTOS_JSON_PATH, data);
}

/* =========================================================
   SPECIES HELPERS
========================================================= */

function loadSpeciesData() {
  if (!fs.existsSync(SPECIES_JSON_PATH)) {
    throw new Error(
      `species.json werd niet gevonden op ${SPECIES_JSON_PATH}`
    );
  }

  const content = fs.readFileSync(SPECIES_JSON_PATH, "utf8");
  return JSON.parse(content);
}

function findSpeciesById(speciesId) {
  if (speciesId === null || speciesId === undefined) {
    return null;
  }

  const id = Number(speciesId);

  if (!Number.isInteger(id)) {
    return null;
  }

  const data = loadSpeciesData();

  if (!data || !Array.isArray(data.species)) {
    return null;
  }

  return data.species.find((species) => species.id === id) || null;
}

/* =========================================================
   ALGEMENE HELPERS
========================================================= */

function buildPhotoPageUrl(photoId) {
  return `${PUBLIC_BASE_URL}/photo/${encodeURIComponent(photoId)}`;
}

function buildPhotoFileUrl(filename) {
  return `${PUBLIC_BASE_URL}/uploads/photos/${encodeURIComponent(
    filename
  )}`;
}

function buildQrFileUrl(filename) {
  return `${PUBLIC_BASE_URL}/uploads/qr/${encodeURIComponent(
    filename
  )}`;
}

function isValidPhotoId(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9-]{36}$/i.test(value)
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function removeFileIfExists(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function getRemainingMilliseconds(expiresAt) {
  return new Date(expiresAt).getTime() - Date.now();
}

/* =========================================================
   MULTER-UPLOADCONFIGURATIE
========================================================= */

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => {
    callback(null, PHOTO_UPLOAD_DIR);
  },

  filename: (request, file, callback) => {
    /*
     * Het ID wordt al aangemaakt voordat Multer het bestand
     * opslaat. De route kan daarna hetzelfde ID gebruiken.
     */
    const photoId = request.photoId || crypto.randomUUID();
    request.photoId = photoId;

    /*
     * De gemaakte Unreal-foto wordt altijd als PNG opgeslagen.
     */
    callback(null, `${photoId}.png`);
  },
});


const uploadPhoto = multer({
  storage,

  limits: {
    fileSize: MAX_PHOTO_SIZE_BYTES,
    files: 1,
  },

  fileFilter: (_request, file, callback) => {
    const allowedMimeTypes = new Set([
      "image/png",
      "image/jpeg",
      "image/jpg",
    ]);

    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(
        new Error(
          "Alleen PNG- en JPEG-afbeeldingen zijn toegestaan."
        )
      );
      return;
    }

    callback(null, true);
  },
});

/* =========================================================
   SPECIES API
========================================================= */

app.get("/api/v1/species", (_request, response) => {
  try {
    response.json(loadSpeciesData());
  } catch (error) {
    console.error(error);

    response.status(500).json({
      error: "Speciesgegevens konden niet worden geladen.",
    });
  }
});

app.get("/api/v1/species/:id", (request, response) => {
  try {
    const id = Number(request.params.id);

    if (!Number.isInteger(id)) {
      response.status(400).json({
        error: "Ongeldige species-ID.",
      });
      return;
    }

    const species = findSpeciesById(id);

    if (!species) {
      response.status(404).json({
        error: "Species niet gevonden.",
      });
      return;
    }

    response.json(species);
  } catch (error) {
    console.error(error);

    response.status(500).json({
      error: "Species kon niet worden geladen.",
    });
  }
});

/* =========================================================
   FOTO UPLOADEN EN QR-CODE GENEREREN
========================================================= */

/*
 * Verwacht multipart/form-data:
 *
 * Verplicht:
 * photo = afbeeldingsbestand
 *
 * Optioneel:
 * speciesId = bijvoorbeeld 1
 * pose      = bijvoorbeeld 0 of 1
 */
app.post(
  "/api/v1/photos",
  (request, _response, next) => {
    request.photoId = crypto.randomUUID();
    next();
  },
  uploadPhoto.single("photo"),
  async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({
          error:
            'Geen foto ontvangen. Gebruik het form-data veld "photo".',
        });
        return;
      }

      const photoId = request.photoId;
      const photoFilename = request.file.filename;
      const qrFilename = `${photoId}.png`;

      const qrFilePath = path.join(QR_UPLOAD_DIR, qrFilename);

      const speciesIdProvided =
        request.body.speciesId !== undefined &&
        request.body.speciesId !== "";

      const speciesId = speciesIdProvided
        ? Number(request.body.speciesId)
        : null;

      if (
        speciesIdProvided &&
        !Number.isInteger(speciesId)
      ) {
        await removeFileIfExists(request.file.path);

        response.status(400).json({
          error: "speciesId moet een geheel getal zijn.",
        });
        return;
      }

      const species =
        speciesId !== null ? findSpeciesById(speciesId) : null;

      if (speciesId !== null && !species) {
        await removeFileIfExists(request.file.path);

        response.status(400).json({
          error: "De opgegeven speciesId bestaat niet.",
        });
        return;
      }

      const poseProvided =
        request.body.pose !== undefined &&
        request.body.pose !== "";

      const pose = poseProvided
        ? Number(request.body.pose)
        : null;

      if (
        poseProvided &&
        !Number.isInteger(pose)
      ) {
        await removeFileIfExists(request.file.path);

        response.status(400).json({
          error: "pose moet een geheel getal zijn.",
        });
        return;
      }

      const createdAtDate = new Date();
      const expiresAtDate = new Date(
        createdAtDate.getTime() +
          PHOTO_LIFETIME_HOURS * 60 * 60 * 1000
      );

      const photoPageUrl = buildPhotoPageUrl(photoId);

      /*
       * De QR-code bevat de URL naar de downloadpagina,
       * niet rechtstreeks het lokale bestandspad.
       */
      await QRCode.toFile(qrFilePath, photoPageUrl, {
        type: "png",
        width: 700,
        margin: 2,
        errorCorrectionLevel: "H",
        color: {
          dark: "#000000",
          light: "#FFFFFF",
        },
      });

      const photoRecord = {
        id: photoId,
        filename: photoFilename,
        qrFilename,
        originalFilename: request.file.originalname,
        mimeType: request.file.mimetype,
        sizeBytes: request.file.size,

        speciesId: species ? species.id : null,
        speciesName: species ? species.name : null,
        pose,

        createdAt: createdAtDate.toISOString(),
        expiresAt: expiresAtDate.toISOString(),
      };

      const photosData = await loadPhotosData();
      photosData.photos.push(photoRecord);
      await savePhotosData(photosData);

      response.status(201).json({
        success: true,
        message: "Foto en QR-code zijn aangemaakt.",

        photo: {
          id: photoRecord.id,
          speciesId: photoRecord.speciesId,
          speciesName: photoRecord.speciesName,
          pose: photoRecord.pose,
          createdAt: photoRecord.createdAt,
          expiresAt: photoRecord.expiresAt,

          pageUrl: photoPageUrl,
          fileUrl: buildPhotoFileUrl(photoFilename),
          qrUrl: buildQrFileUrl(qrFilename),
        },
      });
    } catch (error) {
      /*
       * Wanneer de foto al op schijf staat maar iets anders
       * mislukt, ruimen we het bestand opnieuw op.
       */
      if (request.file?.path) {
        await removeFileIfExists(request.file.path).catch(
          console.error
        );
      }

      if (request.photoId) {
        const qrPath = path.join(
          QR_UPLOAD_DIR,
          `${request.photoId}.png`
        );

        await removeFileIfExists(qrPath).catch(console.error);
      }

      next(error);
    }
  }
);

/* =========================================================
   FOTO-INFORMATIE ALS JSON
========================================================= */

app.get("/api/v1/photos/:id", async (request, response, next) => {
  try {
    const photoId = request.params.id;

    if (!isValidPhotoId(photoId)) {
      response.status(400).json({
        error: "Ongeldige foto-ID.",
      });
      return;
    }

    const photosData = await loadPhotosData();

    const photo = photosData.photos.find(
      (item) => item.id === photoId
    );

    if (!photo) {
      response.status(404).json({
        error: "Foto niet gevonden.",
      });
      return;
    }

    if (getRemainingMilliseconds(photo.expiresAt) <= 0) {
      response.status(410).json({
        error: "Deze foto is verlopen.",
      });
      return;
    }

    response.json({
      ...photo,
      pageUrl: buildPhotoPageUrl(photo.id),
      fileUrl: buildPhotoFileUrl(photo.filename),
      qrUrl: buildQrFileUrl(photo.qrFilename),
    });
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   DOWNLOADPAGINA
========================================================= */

app.get("/photo/:id", async (request, response, next) => {
  try {
    const photoId = request.params.id;

    if (!isValidPhotoId(photoId)) {
      response.status(400).send(
        createMessagePage(
          "Ongeldige fotolink",
          "Deze fotolink is niet geldig."
        )
      );
      return;
    }

    const photosData = await loadPhotosData();

    const photo = photosData.photos.find(
      (item) => item.id === photoId
    );

    if (!photo) {
      response.status(404).send(
        createMessagePage(
          "Foto niet gevonden",
          "Deze foto bestaat niet of werd al verwijderd."
        )
      );
      return;
    }

    if (getRemainingMilliseconds(photo.expiresAt) <= 0) {
      response.status(410).send(
        createMessagePage(
          "Foto verlopen",
          "Deze foto is niet meer beschikbaar."
        )
      );
      return;
    }

    const photoFilePath = path.join(
      PHOTO_UPLOAD_DIR,
      photo.filename
    );

    try {
      await fsp.access(photoFilePath);
    } catch {
      response.status(404).send(
        createMessagePage(
          "Bestand niet gevonden",
          "Het fotobestand kon niet worden gevonden."
        )
      );
      return;
    }

    const safeSpeciesName = photo.speciesName
      ? escapeHtml(photo.speciesName)
      : "Evolution Wall";

    const fileUrl = `/uploads/photos/${encodeURIComponent(
      photo.filename
    )}`;

    const downloadUrl = `/photo/${encodeURIComponent(
      photo.id
    )}/download`;

    response.type("html").send(`<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>Uw Evolution Wall-foto</title>

  <style>
    :root {
      color-scheme: dark;
      font-family:
        Inter,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, #303030, #0b0b0b 65%);
      color: #ffffff;
    }

    main {
      width: min(900px, 100%);
      padding: 24px;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 24px;
      background: rgba(15, 15, 15, 0.9);
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.5);
      text-align: center;
    }

    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 6vw, 48px);
    }

    .subtitle {
      margin: 0 0 24px;
      color: rgba(255, 255, 255, 0.72);
    }

    img {
      display: block;
      width: 100%;
      max-height: 70vh;
      object-fit: contain;
      margin: 0 auto;
      border-radius: 16px;
      background: #000000;
    }

    .actions {
      margin-top: 24px;
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 12px;
    }

    .button {
      display: inline-flex;
      min-height: 50px;
      padding: 12px 24px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: #ffffff;
      color: #111111;
      font-weight: 700;
      text-decoration: none;
    }

    .info {
      margin-top: 18px;
      color: rgba(255, 255, 255, 0.62);
      font-size: 14px;
    }
  </style>
</head>

<body>
  <main>
    <h1>Uw foto is klaar</h1>

    <p class="subtitle">
      Gefotografeerd met ${safeSpeciesName}
    </p>

    <img
      src="${fileUrl}"
      alt="Uw Evolution Wall-foto"
    >

    <div class="actions">
      <a class="button" href="${downloadUrl}">
        Foto downloaden
      </a>
    </div>

    <p class="info">
      Deze foto wordt automatisch verwijderd na
      ${PHOTO_LIFETIME_HOURS} uur.
    </p>
  </main>
</body>
</html>`);
  } catch (error) {
    next(error);
  }
});

/* =========================================================
   FOTO DOWNLOADEN
========================================================= */

app.get(
  "/photo/:id/download",
  async (request, response, next) => {
    try {
      const photoId = request.params.id;

      if (!isValidPhotoId(photoId)) {
        response.status(400).json({
          error: "Ongeldige foto-ID.",
        });
        return;
      }

      const photosData = await loadPhotosData();

      const photo = photosData.photos.find(
        (item) => item.id === photoId
      );

      if (!photo) {
        response.status(404).json({
          error: "Foto niet gevonden.",
        });
        return;
      }

      if (getRemainingMilliseconds(photo.expiresAt) <= 0) {
        response.status(410).json({
          error: "Deze foto is verlopen.",
        });
        return;
      }

      const photoFilePath = path.join(
        PHOTO_UPLOAD_DIR,
        photo.filename
      );

      /*
       * Mooie downloadnaam.
       */
      const downloadFilename = photo.speciesName
        ? `evolution-wall-${photo.speciesName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")}.png`
        : "evolution-wall-foto.png";

      response.download(
        photoFilePath,
        downloadFilename,
        (error) => {
          if (error && !response.headersSent) {
            next(error);
          }
        }
      );
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   FOTO HANDMATIG VERWIJDEREN
========================================================= */

app.delete(
  "/api/v1/photos/:id",
  async (request, response, next) => {
    try {
      const photoId = request.params.id;

      if (!isValidPhotoId(photoId)) {
        response.status(400).json({
          error: "Ongeldige foto-ID.",
        });
        return;
      }

      const photosData = await loadPhotosData();

      const photoIndex = photosData.photos.findIndex(
        (item) => item.id === photoId
      );

      if (photoIndex === -1) {
        response.status(404).json({
          error: "Foto niet gevonden.",
        });
        return;
      }

      const [photo] = photosData.photos.splice(photoIndex, 1);

      await Promise.all([
        removeFileIfExists(
          path.join(PHOTO_UPLOAD_DIR, photo.filename)
        ),
        removeFileIfExists(
          path.join(QR_UPLOAD_DIR, photo.qrFilename)
        ),
      ]);

      await savePhotosData(photosData);

      response.json({
        success: true,
        message: "Foto en QR-code zijn verwijderd.",
      });
    } catch (error) {
      next(error);
    }
  }
);

/* =========================================================
   AUTOMATISCHE VERWIJDERING
========================================================= */

async function cleanupExpiredPhotos() {
  const photosData = await loadPhotosData();

  const now = Date.now();
  const activePhotos = [];
  const expiredPhotos = [];

  for (const photo of photosData.photos) {
    const expiresAt = new Date(photo.expiresAt).getTime();

    if (
      Number.isFinite(expiresAt) &&
      expiresAt <= now
    ) {
      expiredPhotos.push(photo);
    } else {
      activePhotos.push(photo);
    }
  }

  if (expiredPhotos.length === 0) {
    return;
  }

  for (const photo of expiredPhotos) {
    await Promise.all([
      removeFileIfExists(
        path.join(PHOTO_UPLOAD_DIR, photo.filename)
      ),
      removeFileIfExists(
        path.join(QR_UPLOAD_DIR, photo.qrFilename)
      ),
    ]);
  }

  photosData.photos = activePhotos;
  await savePhotosData(photosData);

  console.log(
    `${expiredPhotos.length} verlopen foto('s) verwijderd.`
  );
}

/* =========================================================
   HEALTH ENDPOINT
========================================================= */

app.get("/health", async (_request, response) => {
  let photoCount = 0;

  try {
    const photosData = await loadPhotosData();
    photoCount = photosData.photos.length;
  } catch {
    photoCount = -1;
  }

  response.json({
    status: "ok",
    service: "Evolution Wall API",
    publicBaseUrl: PUBLIC_BASE_URL,
    photoLifetimeHours: PHOTO_LIFETIME_HOURS,
    storedPhotos: photoCount,
    currentTime: new Date().toISOString(),
  });
});

app.get("/qr/:id", async (req, res) => {
    const photos = await loadPhotosData();

    const photo = photos.photos.find(p => p.id === req.params.id);

    if (!photo)
        return res.status(404).send("QR niet gevonden");

    res.sendFile(path.join(QR_UPLOAD_DIR, photo.qrFilename));
});

app.get("/api/v1/photos", async (req, res) => {
    const data = await loadPhotosData();
    res.json(data);
});

/* =========================================================
   404
========================================================= */

app.use((_request, response) => {
  response.status(404).json({
    error: "Endpoint niet gevonden.",
  });
});

/* =========================================================
   ERROR HANDLING
========================================================= */

app.use((error, _request, response, _next) => {
  console.error(error);

  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      response.status(413).json({
        error: "De foto is te groot. Maximum is 15 MB.",
      });
      return;
    }

    response.status(400).json({
      error: `Uploadfout: ${error.message}`,
    });
    return;
  }

  if (
    error.message ===
    "Alleen PNG- en JPEG-afbeeldingen zijn toegestaan."
  ) {
    response.status(415).json({
      error: error.message,
    });
    return;
  }

  response.status(500).json({
    error: "Er is een interne serverfout opgetreden.",
  });
});

/* =========================================================
   HTML HELPER
========================================================= */

function createMessagePage(title, message) {
  return `<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <title>${escapeHtml(title)}</title>

  <style>
    body {
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      display: grid;
      place-items: center;
      background: #101010;
      color: #ffffff;
      font-family:
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      text-align: center;
    }

    main {
      width: min(600px, 100%);
      padding: 32px;
      border-radius: 24px;
      background: #202020;
    }

    h1 {
      margin-top: 0;
    }

    p {
      color: rgba(255, 255, 255, 0.75);
    }
  </style>
</head>

<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

/* =========================================================
   SERVER STARTEN
========================================================= */

async function startServer() {
  await ensureProjectFiles();
  await cleanupExpiredPhotos();

  /*
   * Elk uur verlopen foto's verwijderen.
   */
  setInterval(() => {
    cleanupExpiredPhotos().catch((error) => {
      console.error(
        "Automatische foto-opruiming is mislukt:",
        error
      );
    });
}, 60 * 1000);

  app.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("Evolution Wall API is gestart.");
    console.log(`Poort: ${PORT}`);
    console.log(`Publieke basis-URL: ${PUBLIC_BASE_URL}`);
    console.log(
      `Species: ${PUBLIC_BASE_URL}/api/v1/species`
    );
    console.log(
      `Upload: ${PUBLIC_BASE_URL}/api/v1/photos`
    );
    console.log(`Health: ${PUBLIC_BASE_URL}/health`);
    console.log("");
  });
}

startServer().catch((error) => {
  console.error("De server kon niet starten:", error);
  process.exit(1);
});