"use strict";

const { contextBridge } = require("electron");

if (process.isMainFrame) contextBridge.exposeInMainWorld("roomsDesktop", true);
