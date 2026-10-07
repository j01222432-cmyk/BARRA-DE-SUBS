const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUERTO = Number(process.env.PORT) || 3010;
const ARCHIVO = path.join(__dirname, "data", "contador.json");
const VENTANA_MS = 15 * 60 * 1000;
let clavePublica = null;
let claveDesde = 0;

const tipos = {
  "text/html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function leerEstado() {
  try {
    const datos = JSON.parse(fs.readFileSync(ARCHIVO, "utf8"));
    return {
      total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : 0,
      mensajes: Array.isArray(datos.mensajes) ? datos.mensajes : [],
      recientes: Array.isArray(datos.recientes) ? datos.recientes : []
    };
  } catch {
    return { total: 0, mensajes: [], recientes: [] };
  }
}

function guardarEstado(estado) {
  fs.mkdirSync(path.dirname(ARCHIVO), { recursive: true });
  fs.writeFileSync(ARCHIVO, JSON.stringify(estado));
}

function aplicarEvento(estado, tipo, cuerpo, mensajeId) {
  if (!mensajeId || estado.mensajes.includes(mensajeId)) return 0;
  estado.mensajes.push(mensajeId);
  if (estado.mensajes.length > 400) estado.mensajes = estado.mensajes.slice(-400);

  const ahora = Date.now();
  estado.recientes = estado.recientes.filter((item) => ahora - item.at < VENTANA_MS);

  let suma = 0;
  if (tipo === "channel.subscription.new" || tipo === "channel.subscription.renewal") {
    const id = cuerpo && cuerpo.subscriber && cuerpo.subscriber.user_id;
    if (id && estado.recientes.some((item) => item.id === id)) return 0;
    if (id) estado.recientes.push({ id, at: ahora });
    suma = 1;
  } else if (tipo === "channel.subscription.gifts") {
    const giftees = cuerpo && Array.isArray(cuerpo.giftees) ? cuerpo.giftees : [];
    if (!giftees.length) {
      suma = 1;
    } else {
      giftees.forEach((persona) => {
        const id = persona && persona.user_id;
        if (id && estado.recientes.some((item) => item.id === id)) return;
        if (id) estado.recientes.push({ id, at: ahora });
        suma += 1;
      });
    }
  } else {
    return 0;
  }

  estado.total += suma;
  return suma;
}

function obtenerClavePublica() {
  if (clavePublica && Date.now() - claveDesde < 60 * 60 * 1000) {
    return Promise.resolve(clavePublica);
  }
  return new Promise((resolve, reject) => {
    const solicitud = require("https").get("https://api.kick.com/public/v1/public-key", (respuesta) => {
      const trozos = [];
      respuesta.on("data", (trozo) => trozos.push(trozo));
      respuesta.on("end", () => {
        clavePublica = Buffer.concat(trozos).toString("utf8");
        claveDesde = Date.now();
        resolve(clavePublica);
      });
    });
    solicitud.on("error", reject);
  });
}

function firmaValida(clave, mensajeId, marcaTiempo, cuerpo, firma) {
  const mensaje = Buffer.from(mensajeId + "." + marcaTiempo + "." + cuerpo);
  const sello = Buffer.from(firma, "base64");
  return crypto.verify("sha256", mensaje, clave, sello);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    req.on("data", (trozo) => trozos.push(trozo));
    req.on("end", () => resolve(Buffer.concat(trozos).toString("utf8")));
    req.on("error", reject);
  });
}

function enviar(res, codigo, contenido, tipo) {
  res.writeHead(codigo, {
    "Content-Type": tipo || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(contenido);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/api/contador") {
    enviar(res, 200, JSON.stringify({ total: leerEstado().total }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/kick") {
    const crudo = await leerCuerpo(req);
    const tipo = req.headers["kick-event-type"];
    const mensajeId = req.headers["kick-event-message-id"];
    const marcaTiempo = req.headers["kick-event-message-timestamp"];
    const firma = req.headers["kick-event-signature"];

    if (process.env.KICK_SKIP_VERIFY !== "1") {
      if (!mensajeId || !marcaTiempo || !firma) {
        enviar(res, 401, JSON.stringify({ error: "Falta la firma de Kick" }));
        return;
      }
      try {
        const clave = await obtenerClavePublica();
        if (!firmaValida(clave, mensajeId, marcaTiempo, crudo, firma)) {
          enviar(res, 401, JSON.stringify({ error: "Firma invalida" }));
          return;
        }
      } catch {
        enviar(res, 401, JSON.stringify({ error: "No se pudo comprobar la firma" }));
        return;
      }
    }

    let cuerpo = {};
    try {
      cuerpo = crudo ? JSON.parse(crudo) : {};
    } catch {
      enviar(res, 400, JSON.stringify({ error: "JSON invalido" }));
      return;
    }

    const estado = leerEstado();
    const suma = aplicarEvento(estado, tipo, cuerpo, mensajeId || crypto.randomUUID());
    guardarEstado(estado);
    enviar(res, 200, JSON.stringify({ ok: true, suma, total: estado.total }));
    return;
  }

  if (req.method !== "GET") {
    enviar(res, 405, JSON.stringify({ error: "Metodo no permitido" }));
    return;
  }

  const relativo = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const archivo = path.resolve(__dirname, relativo);
  const raiz = path.resolve(__dirname);
  const relativoSeguro = path.relative(raiz, archivo);
  if (relativoSeguro.startsWith("..") || path.isAbsolute(relativoSeguro) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    enviar(res, 404, "No encontrado", "text/plain; charset=utf-8");
    return;
  }
  const extension = path.extname(archivo);
  res.writeHead(200, { "Content-Type": tipos[extension] || "application/octet-stream" });
  fs.createReadStream(archivo).pipe(res);
});

if (require.main === module) {
  servidor.listen(PUERTO, () => {
    console.log("Barra lista en http://127.0.0.1:" + PUERTO);
  });
}

module.exports = { aplicarEvento, leerEstado, guardarEstado };
