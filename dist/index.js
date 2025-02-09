"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
const httpServer = (0, http_1.createServer)(app);
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: ["http://localhost:4200", "http://localhost:3001"], // Angular y React URLs
        methods: ["GET", "POST"],
        credentials: true,
    },
});
const clients = [];
io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);
    // Cuando el cliente TV se conecta
    socket.on("clientConnected", () => {
        clients.push({ id: socket.id, type: "tv" });
        console.log("TV client connected");
    });
    // Cuando el controlador envía comandos
    socket.on("command", (command) => {
        console.log("Command received:", command);
        // Enviar el comando solo a los clientes TV
        clients
            .filter((client) => client.type === "tv")
            .forEach((client) => {
            io.to(client.id).emit("command", command);
        });
    });
    // Cuando el controlador envía su estado
    socket.on("controllerState", (state) => {
        console.log("Controller state received:", state);
        // Enviar el estado a los clientes TV
        clients
            .filter((client) => client.type === "tv")
            .forEach((client) => {
            io.to(client.id).emit("controllerState", state);
        });
    });
    // Cuando el cliente TV envía actualizaciones de estado
    socket.on("playbackStatus", (status) => {
        console.log("Playback status received:", status);
        // Enviar el estado a todos los controladores
        clients
            .filter((client) => client.type === "controller")
            .forEach((client) => {
            io.to(client.id).emit("playbackStatus", status);
        });
    });
    socket.on("disconnect", () => {
        const index = clients.findIndex((client) => client.id === socket.id);
        if (index !== -1) {
            const clientType = clients[index].type;
            clients.splice(index, 1);
            console.log(`${clientType} client disconnected:`, socket.id);
        }
    });
});
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Socket.IO server running on port ${PORT}`);
});
