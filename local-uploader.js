const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 3001;

const LOCAL_PHOTO_LIFETIME_MS = 60 * 60 * 1000;
const LOCAL_CLEANUP_INTERVAL_MS = 60 * 1000;


const ONLINE_UPLOAD_URL =
  "https://evolution-wall-data.onrender.com/api/v1/photos";

const ALLOWED_PHOTO_FOLDER_SUFFIX =
  `${path.sep}Content${path.sep}Photos`;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "Evolution Wall Local Uploader",
  });
});

async function removeLocalPhoto(filePath) {
  try {
    const resolvedPath = path.resolve(filePath);

    const normalizedFolder = path.normalize(
      path.dirname(resolvedPath)
    );

    // Veiligheid: alleen bestanden uit Content/Photos verwijderen
    if (
      !normalizedFolder.endsWith(
        ALLOWED_PHOTO_FOLDER_SUFFIX
      )
    ) {
      console.error(
        "Verwijderen geweigerd: bestand staat niet in Content/Photos",
        resolvedPath
      );

      return;
    }

    await fs.promises.unlink(resolvedPath);

    console.log(
      "Lokale Unreal-foto verwijderd:",
      resolvedPath
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }

    console.error(
      "Lokale foto kon niet worden verwijderd:",
      filePath,
      error
    );
  }
}

function scheduleLocalPhotoDeletion(filePath) {
  const timer = setTimeout(() => {
    removeLocalPhoto(filePath);
  }, LOCAL_PHOTO_LIFETIME_MS);

  // Zorgt ervoor dat deze timer Node niet onnodig actief houdt
  timer.unref?.();
}

async function cleanupOldLocalPhotos() {
  try {
    const projectPhotosFolder =
      process.env.UNREAL_PHOTOS_DIR;

    if (!projectPhotosFolder) {
      return;
    }

    const resolvedFolder =
      path.resolve(projectPhotosFolder);

    const normalizedFolder =
      path.normalize(resolvedFolder);

    if (
      !normalizedFolder.endsWith(
        ALLOWED_PHOTO_FOLDER_SUFFIX
      )
    ) {
      console.error(
        "UNREAL_PHOTOS_DIR moet eindigen op Content/Photos:",
        resolvedFolder
      );

      return;
    }

    if (!fs.existsSync(resolvedFolder)) {
      return;
    }

    const filenames =
      await fs.promises.readdir(resolvedFolder);

    const now = Date.now();

    for (const filename of filenames) {
      const extension =
        path.extname(filename).toLowerCase();

      if (
        extension !== ".png" &&
        extension !== ".jpg" &&
        extension !== ".jpeg"
      ) {
        continue;
      }

      const fullPath =
        path.join(resolvedFolder, filename);

      const stats =
        await fs.promises.stat(fullPath);

      const age =
        now - stats.mtimeMs;

      if (age >= LOCAL_PHOTO_LIFETIME_MS) {
        await removeLocalPhoto(fullPath);
      }
    }
  } catch (error) {
    console.error(
      "Opruimen van lokale Unreal-foto's is mislukt:",
      error
    );
  }
}

app.post("/upload-photo", async (req, res) => {
  try {
    const {
      filePath,
      filename,
      speciesId,
      pose,
    } = req.body;

    if (
      typeof filePath !== "string" ||
      filePath.trim() === ""
    ) {
      return res.status(400).json({
        success: false,
        error: "filePath ontbreekt",
      });
    }

    if (
      typeof filename !== "string" ||
      filename.trim() === ""
    ) {
      return res.status(400).json({
        success: false,
        error: "filename ontbreekt",
      });
    }

    if (
      speciesId === undefined ||
      speciesId === null ||
      !Number.isInteger(Number(speciesId))
    ) {
      return res.status(400).json({
        success: false,
        error: "speciesId ontbreekt of is ongeldig",
      });
    }

    const resolvedFilePath = path.resolve(filePath);
    const normalizedPhotoFolder = path.normalize(
      path.dirname(resolvedFilePath)
    );

    // Alleen bestanden uit een projectmap Content/Photos toelaten
    if (
      !normalizedPhotoFolder.endsWith(
        ALLOWED_PHOTO_FOLDER_SUFFIX
      )
    ) {
      return res.status(403).json({
        success: false,
        error:
          "Het bestand moet in de projectmap Content/Photos staan",
        receivedFolder: normalizedPhotoFolder,
      });
    }

    const actualFilename =
      path.basename(resolvedFilePath);

    // Extra controle dat Unreal dezelfde bestandsnaam doorstuurt
    if (actualFilename !== filename) {
      return res.status(400).json({
        success: false,
        error:
          "filename komt niet overeen met de bestandsnaam in filePath",
        expectedFilename: actualFilename,
        receivedFilename: filename,
      });
    }

    const extension =
      path.extname(actualFilename).toLowerCase();

    if (
      extension !== ".png" &&
      extension !== ".jpg" &&
      extension !== ".jpeg"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Alleen PNG- en JPG-afbeeldingen zijn toegestaan",
      });
    }

    if (!fs.existsSync(resolvedFilePath)) {
      return res.status(404).json({
        success: false,
        error: "Foto werd lokaal niet gevonden",
        filePath: resolvedFilePath,
      });
    }

    const fileStats =
      await fs.promises.stat(resolvedFilePath);

    if (!fileStats.isFile()) {
      return res.status(400).json({
        success: false,
        error: "Het opgegeven pad is geen bestand",
      });
    }

    const fileBuffer =
      await fs.promises.readFile(resolvedFilePath);

    const mimeType =
      extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : "image/png";

    const formData = new FormData();

    formData.append(
      "photo",
      new Blob([fileBuffer], {
        type: mimeType,
      }),
      actualFilename
    );

    formData.append(
      "speciesId",
      String(Number(speciesId))
    );

    formData.append(
      "pose",
      String(Number(pose ?? 0))
    );

    console.log("");
    console.log("Foto wordt geüpload:");
    console.log("Bestand:", resolvedFilePath);
    console.log("Species ID:", speciesId);
    console.log("Pose:", pose ?? 0);

    const onlineResponse = await fetch(
      ONLINE_UPLOAD_URL,
      {
        method: "POST",
        body: formData,
      }
    );

    const responseText =
      await onlineResponse.text();

    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = {
        rawResponse: responseText,
      };
    }

    if (!onlineResponse.ok) {
      console.error(
        "Online upload mislukt:",
        responseData
      );

      return res
        .status(onlineResponse.status)
        .json({
          success: false,
          error:
            "De online Render-upload is mislukt",
          onlineResponse: responseData,
        });
    }

    console.log(
      "Upload gelukt:",
      responseData
    );

    // Verwijder de lokale Unreal-foto één uur na succesvolle upload
    scheduleLocalPhotoDeletion(resolvedFilePath);

    return res.json({
      success: true,
      message:
        "Foto is online opgeslagen en wordt lokaal na één uur verwijderd",
      ...responseData,
    });
  } catch (error) {
    console.error(
      "Lokale uploaderfout:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Onbekende uploaderfout",
    });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log(
    "Evolution Wall Local Uploader draait."
  );
  console.log(
    `Health: http://127.0.0.1:${PORT}/health`
  );
  console.log(
    `Upload: http://127.0.0.1:${PORT}/upload-photo`
  );
  console.log("");

  cleanupOldLocalPhotos();

  const cleanupTimer = setInterval(() => {
    cleanupOldLocalPhotos();
  }, LOCAL_CLEANUP_INTERVAL_MS);

  cleanupTimer.unref?.();
});