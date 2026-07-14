/**
 * @file editor-preload.cjs
 * @description 编辑器窗口的预加载脚本，向渲染进程暴露文件读写、目录扫描与终端控制的 IPC API。
 *
 * VersePC - Minecraft Launcher
 * Copyright (c) 2026 豆杰. All Rights Reserved.
 *
 * AI TRAINING PROHIBITED: This code is protected by copyright law.
 * Unauthorized use for AI model training, machine learning datasets,
 * or any form of artificial intelligence training is strictly prohibited.
 *
 * This software is proprietary and confidential.
 * Any unauthorized reproduction or distribution is prohibited.
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 编辑器窗口暴露给渲染进程的 API 集合
 * @namespace editorAPI
 */
contextBridge.exposeInMainWorld('editorAPI', {
  /**
   * 弹出文件选择对话框
   * @returns {Promise<string>} 用户选择的文件路径
   */
  openFileDialog: () => ipcRenderer.invoke('editor:open-file-dialog'),

  /**
   * 读取指定文件内容
   * @param {string} filePath - 文件绝对路径
   * @returns {Promise<string>} 文件内容
   */
  readFile: (filePath) => ipcRenderer.invoke('editor:read-file', filePath),

  /**
   * 写入内容到指定文件
   * @param {string} filePath - 文件绝对路径
   * @param {string} content - 待写入内容
   * @returns {Promise<boolean>} 是否写入成功
   */
  writeFile: (filePath, content) => ipcRenderer.invoke('editor:write-file', filePath, content),

  /**
   * 扫描指定目录下的文件与子目录
   * @param {string} dirPath - 目录绝对路径
   * @returns {Promise<Array>} 子项列表
   */
  scanDir: (dirPath) => ipcRenderer.invoke('editor:scan-dir', dirPath),

  /**
   * 监听主进程发起的打开文件事件
   * @param {(filePath: string) => void} callback - 文件路径回调
   * @returns {void}
   */
  onOpenFile: (callback) => ipcRenderer.on('editor:open-file', (event, filePath) => callback(filePath)),

  /**
   * 创建终端会话
   * @param {string} id - 终端实例 ID
   * @param {number} cols - 列数
   * @param {number} rows - 行数
   * @returns {Promise<void>}
   */
  createTerminal: (id, cols, rows) => ipcRenderer.invoke('terminal:create', id, cols, rows),

  /**
   * 向终端写入数据
   * @param {string} id - 终端实例 ID
   * @param {string} data - 待写入数据
   * @returns {Promise<void>}
   */
  writeTerminal: (id, data) => ipcRenderer.invoke('terminal:write', id, data),

  /**
   * 终止指定终端会话
   * @param {string} id - 终端实例 ID
   * @returns {Promise<void>}
   */
  killTerminal: (id) => ipcRenderer.invoke('terminal:kill', id),

  /**
   * 监听终端输出数据
   * @param {(id: string, data: string) => void} callback - 数据回调
   * @returns {void}
   */
  onTerminalData: (callback) => ipcRenderer.on('terminal:data', (event, id, data) => callback(id, data)),

  /**
   * 监听终端退出事件
   * @param {(id: string, code: number) => void} callback - 退出回调
   * @returns {void}
   */
  onTerminalExit: (callback) => ipcRenderer.on('terminal:exit', (event, id, code) => callback(id, code))
});
