﻿import api = require("./fs-api");
import misc = require("./fs-misc");
import glob = require("./fs-glob");
import util = require("./util");
import events = require("events");

import IFilesystem = api.IFilesystem;
import IStats = api.IStats;
import IItem = api.IItem;
import FileUtil = misc.FileUtil;
import IDataSource = misc.IDataSource;
import IDataTarget = misc.IDataTarget;
import search = glob.search;
import EventEmitter = events.EventEmitter;

export class FileDataTarget extends EventEmitter implements IDataTarget {
    private fs: IFilesystem;
    private path: string;

    private handle: any;
    private position: number;

    private queue: IChunk[];
    private requests: number;

    private started: boolean;
    private ready: boolean;
    private ended: boolean;
    private finished: boolean;
    private failed: boolean;

    acceptsEmptyBlocks: boolean;

    on(event: string, listener: Function): NodeEventEmitter {
        return super.on(event, listener);
    }

    constructor(fs: IFilesystem, path: string) {
        super();

        this.fs = fs;
        this.path = path;

        this.handle = null;
        this.position = 0;

        this.queue = [];
        this.requests = 0;

        this.started = false;
        this.ready = false;
        this.ended = false;
        this.finished = false;
        FileDataTarget.prototype.acceptsEmptyBlocks = true;
    }

    private _flush(sync: boolean): void {
        if (this.ended) {
            // if there are no outstanding requests or queued data, do the cleanup
            if (this.requests == 0 && this.queue.length == 0) {

                // if the file is still open, close it
                if (this.handle != null) return this._close();

                // finish when there is nothing else to wait for
                if (!this.finished) {
                    this.finished = true;
                    if (sync)
                        process.nextTick(() => super.emit('finish'));
                    else
                        super.emit('finish');
                }

                return;
            }
        }

        // return if not open
        if (!this.handle) return;

        try {
            // with maximum of active write requests, we are not ready to send more
            if (this.requests >= 4) {
                this.ready = false;
                return;
            }

            // otherwise, write more chunks while possible
            while (this.requests < 4) {
                var chunk = this.queue.shift();
                if (!chunk)
                    break;

                this._next(chunk, this.position);
                this.position += chunk.length;
            }

            // emit event when ready do accept more data
            if (!this.ready && !this.ended) {
                this.ready = true;

                // don't emit if called synchronously
                if (!sync) super.emit('drain');
            }
        } catch (err) {
            this._error(err);
        }
    }

    private _next(chunk: IChunk, position: number): void {
        var bytesToWrite = chunk.length;

        //console.log("write", position, bytesToWrite);
        this.requests++;
        try {
            this.fs.write(this.handle, chunk, 0, bytesToWrite, position, err => {
                this.requests--;
                //console.log("write done", err || position);

                if (err) return this._error(err);

                if (typeof chunk.callback === "function") chunk.callback();

                this._flush(false);
            });
        } catch (err) {
            this.requests--;
            this._error(err);
        }
    }

    private _error(err: Error): void {
        this.ready = false;
        this.ended = true;
        this.finished = true;
        this.queue = [];
        this._flush(false);
        process.nextTick(() => super.emit('error', err));
    }

    write(chunk: NodeBuffer, callback?: () => void): boolean {
        // don't accept more data if ended
        if (this.ended)
            return false;

        // enqueue the chunk for processing
        if (chunk.length > 0) {
            (<IChunk>chunk).callback = callback;
            this.queue.push(<IChunk>chunk);
        }

        // open the file if not started yet
        if (!this.started) {
            this._open();
            return false;
        }

        this._flush(true);
        return this.ready;
    }

    private _open(): void {
        if (this.started) return;

        this.started = true;
        try {
            this.fs.open(this.path, "w",(err, handle) => {
                if (err) return this._error(err);

                this.handle = handle;
                this._flush(false);
            });
        } catch (err) {
            this._error(err);
        }
    }

    private _close(): void {
        if (!this.handle) return;

        var handle = this.handle;
        this.handle = null;
        try {
            this.fs.close(handle, err => {
                if (err) return this._error(err);
                this._flush(false);
            });
        } catch (err) {
            this._error(err);
        }
    }

    end(): void {
        this.ready = false;
        this.ended = true;
        this._flush(true);
    }
}

interface IChunk extends NodeBuffer {
    position: number;
    callback?: () => void;
}

export class FileDataSource extends EventEmitter implements IDataSource {
    name: string;
    path: string;
    length: number;
    stats: IStats;

    private fs: IFilesystem;

    private handle: any;
    private nextChunkPosition: number;
    private expectedPosition: number;

    private queue: IChunk[];
    private started: boolean;
    private eof: boolean;
    private closed: boolean;
    private ended: boolean;
    private requests: number;
    private readable: boolean;
    private failed: boolean;

    constructor(fs: IFilesystem, path: string, name?: string, stats?: IStats, position?: number) {
        super();
        this.fs = fs;
        this.path = path;
        this.name = name || FileUtil.getFileName(path);
        if (stats) {
            this.length = stats.size;
            this.stats = stats;
        } else {
            this.length = null;
            this.stats = null;
        }

        this.handle = null;
        this.nextChunkPosition = this.expectedPosition = position || 0;
        this.queue = [];
        this.started = false;
        this.eof = false;
        this.closed = false;
        this.ended = false;
        this.requests = 0;
        this.readable = false;
        this.failed = false;
    }

    on(event: string, listener: Function): NodeEventEmitter {
        this._flush();
        return super.on(event, listener);
    }

    private _flush(): void {
        try {
            if (this.closed || this.eof) {
                // if there are still outstanding requests, do nothing yet
                if (this.requests > 0) return;

                // if the file is still open, close it
                if (this.handle != null) return this._close();

                // wait for all readable blocks to be read
                if (this.readable) return;

                // end when there is nothing else to wait for
                if (!this.ended) {
                    this.ended = true;
                    if (!this.failed)
                        process.nextTick(() => super.emit('end'));
                }

                return;
            }

            // open the file if not open yet
            if (!this.started) return this._open();

            // return if not open
            if (this.handle == null) return;

            // read more data if possible
            while (this.requests < 4) {
                if (this.closed)
                    break;

                if ((this.nextChunkPosition - this.expectedPosition) > 0x20000)
                    break;

                var chunkSize = 0x8000;
                this._next(this.nextChunkPosition, chunkSize);
                this.nextChunkPosition += chunkSize
            }
        } catch (err) {
            this._error(err);
        }
    }

    private _next(position: number, bytesToRead: number): void {
        //console.log("read", position, bytesToRead);
        this.requests++;
        try {
            this.fs.read(this.handle, new Buffer(bytesToRead), 0, bytesToRead, position,(err, bytesRead, buffer) => {
                this.requests--;
                //console.log("read result", err || position, bytesRead);

                if (err) return this._error(err);

                if (this.closed) {
                    this._flush();
                    return;
                }

                if (bytesRead == 0) {
                    this.eof = true;
                    this._flush();
                    return;
                }

                try {
                    // prepare the chunk for the queue
                    var chunk = <IChunk>buffer.slice(0, bytesRead); //WEB: var chunk = <IChunk>buffer.subarray(0, bytesRead);
                    chunk.position = position;

                    // insert the chunk into the appropriate position in the queue
                    var index = this.queue.length
                    while (--index >= 0) {
                        if (position > this.queue[index].position)
                            break;
                    }
                    this.queue.splice(++index, 0, chunk);

                    // if incomplete chunk was received, read the rest of its data
                    if (bytesRead > 0 && bytesRead < bytesToRead)
                        this._next(position + bytesRead, bytesToRead - bytesRead);

                    this._flush();

                    if (!this.readable && index == 0 && chunk.position == this.expectedPosition) {
                        this.readable = true;
                        if (chunk.length > 0)
                            super.emit('readable');
                    }
                } catch (err) {
                    this._error(err);
                }
            });
        } catch (err) {
            this.requests--;
            this._error(err);
        }
    }

    read(): NodeBuffer {
        var chunk = this.queue[0];
        if (chunk && chunk.position == this.expectedPosition) {
            this.expectedPosition += chunk.length;
            this.queue.shift();
            if (this.queue.length == 0 || this.queue[0].position != this.expectedPosition)
                this.readable = false;
        } else {
            chunk = null;
        }

        this._flush();

        return chunk;
    }

    private _error(err: Error): void {
        this.closed = true;
        this.failed = true;
        this.queue = [];
        this._flush();
        process.nextTick(() => super.emit('error', err));
    }

    private _open(): void {
        if (this.started) return;

        this.started = true;
        try {
            this.fs.open(this.path, "r",(err, handle) => {
                if (err) return this._error(err);

                if (this.stats) {
                    this.handle = handle;
                    this._flush();
                    return;
                }

                // determine stats if not available yet
                try {
                    this.fs.fstat(handle,(err, stats) => {
                        if (err) return this._error(err);

                        this.handle = handle;
                        this.stats = stats;
                        this.length = stats.size;
                        this._flush();
                        return;
                    });
                } catch (err) {
                    this._error(err);
                }
            });
        } catch (err) {
            this._error(err);
        }
    }

    private _close(): void {
        if (!this.handle) return;

        var handle = this.handle;
        this.handle = null;
        try {        
            this.fs.close(handle, err => {
                if (err) return this._error(err);
                this._flush();
            });
            return;
        } catch (err) {
            this._error(err);
        }
    }

    close(): void {
        this.closed = true;
        this.queue = [];
        this._flush();
    }
}

class BlobDataSource extends EventEmitter implements IDataSource {
    name: string;
    length: number;

    private blob: Blob;
    private pos: number;
    private reader: FileReader;
    private busy: boolean;
    private readable: boolean;
    private finished: boolean;
    private ended: boolean;
    private queue: NodeBuffer[];

    constructor(blob: Blob, position: number) {
        super();
        this.name = (<any>blob).name;
        this.length = blob.size;

        this.blob = blob;
        this.pos = position;
        this.reader = new FileReader();
        this.busy = false;
        this.readable = false;
        this.finished = false;
        this.ended = false;
        this.queue = [];

        this.reader.onload = (e: any) => {
            this.busy = false;

            if (!this.finished) {
                var chunk = new Buffer(e.target.result);
                if (chunk.length > 0) {
                    this.queue.push(chunk);
                    if (!this.readable) {
                        this.readable = true;
                        super.emit('readable');
                    }
                } else {
                    this.finished = true;
                }
            }

            this.flush();
        };
    }

    on(event: string, listener: Function): NodeEventEmitter {
        this.flush();
        return super.on(event, listener);
    }

    private flush(): void {
        try {
            if (this.finished) {
                if (!this.ended) {
                    this.ended = true;
                    process.nextTick(() => super.emit('end'));
                }

                return;
            }

            if (!this.busy && this.queue.length < 4) {
                var slice = this.blob.slice(this.pos, this.pos + 0x8000);
                this.pos += slice.size;
                this.busy = true;
                this.reader.readAsArrayBuffer(slice);
            }

        } catch (err) {
            this.finished = true;
            this.ended = true;
            this.queue = [];
            process.nextTick(() => super.emit('error', err));
        }
    }

    read(): NodeBuffer {
        var chunk = this.queue.shift();
        if (!chunk) {
            chunk = null;
            this.readable = false;
        }
        
        this.flush();
        return chunk;
    }

    close(): void {
        this.finished = true;
        this.flush();
    }
}

export function toDataSource(fs: IFilesystem, input: any, emitter: NodeEventEmitter, callback: (err: Error, sources?: IDataSource[]) => void): void {
    try
    {
        toAnyDataSource(input, callback);
    } catch (err) {
        process.nextTick(() => callback(err));
    }

    function toAnyDataSource(input: any, callback: (err: Error, source?: IDataSource[]) => void): void {
        // arrays
        if (isArray(input)) return toArrayDataSource(<any[]>input);

        // string paths
        if (isString(input)) return toPatternDataSource(<string>input);

        // Blob objects
        if (isFileBlob(input)) return openBlobDataSource(input);

        throw new Error("Unsupported source");
    }

    function openBlobDataSource(blob: Blob): void {
        process.nextTick(() => {
            var source = <IDataSource><any>new BlobDataSource(blob, 0);
            callback(null, [source]);
        });
    }

    function isFileBlob(input: any): boolean {
        return (typeof input === "object" && typeof input.size === "number" && typeof input.name === "string" && typeof input.slice == "function");
    }

    function isString(input: any): boolean {
        return typeof input === "string";
    }

    function isArray(input: any) {
        if (Array.isArray(input)) return true;
        if (typeof input !== "object" || typeof input.length !== "number") return false;
        if (input.length == 0) return true;
        return isString(input) || isFileBlob(input[0]);
    }

    function toArrayDataSource(input: any[]): void {
        var source = <IDataSource[]>[];
        var array = <any[]>[];
        Array.prototype.push.apply(array, input);
        next();

        function next(): void {
            try {
                var item = array.shift();
                if (!item) return callback(null, source);

                if (isArray(item)) throw new Error("Unsupported array of arrays data source");

                if (isString(item))
                    toItemDataSource(<string>item, add);
                else
                    toAnyDataSource(item, add);
            } catch (err) {
                process.nextTick(() => callback(err));
            }
        }

        function add(err: Error, src: IDataSource[]): void {
            if (err) return callback(err, null);
            Array.prototype.push.apply(source, src);
            next();
        }
    }

    function toItemDataSource(path: string, callback: (err: Error, source?: IDataSource[]) => void): void {
        if (!fs) throw new Error("Source file system not available");

        fs.stat(path,(err, stats) => {
            if (err) return callback(err, null);

            var item = new FileDataSource(fs, path, FileUtil.getFileName(path), stats, 0);
            callback(null, [item]);
        });
    }

    function toPatternDataSource(path: string): void {
        if (!fs) throw new Error("Source file system not available");

        search(fs, path, emitter, {},(err, items) => {
            if (err) return callback(err, null);

            var source = <IDataSource[]>[];
            items.forEach(it => {
                var item = new FileDataSource(fs, it.path, it.relativePath, it.stats, 0);
                source.push(item);
            });

            callback(null, source);
        });
    }
}


