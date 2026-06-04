const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 5177);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".obj": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (url.pathname === "/") filePath = path.join(root, "BodyLab3_WebGLViewer", "index.html");
  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = fs.statSync(filePath);
    }
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, () => {
  console.log(`BODYLAB3 WebGL viewer: http://localhost:${port}/BodyLab3_WebGLViewer/`);
});


