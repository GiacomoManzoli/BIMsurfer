import RenderLayer from './renderlayer.js'
import Octree from './octree.js'
import Frustum from './frustum.js'
import LineBoxGeometry from './lineboxgeometry.js'
import Executor from './executor.js'
import GeometryLoader from "./geometryloader.js"
import BufferManagerTransparencyOnly from './buffermanagertransparencyonly.js'
import BufferManagerPerColor from './buffermanagerpercolor.js'
import Utils from './utils.js'

export default class TilingRenderLayer extends RenderLayer {
	constructor(viewer, geometryDataToReuse, bounds) {
		super(viewer, geometryDataToReuse);
//		var slightlyLargerBounds = [bounds[0] - 0.01, bounds[1] - 0.01, bounds[2] - 0.01, bounds[3] + 0.02, bounds[4] + 0.02, bounds[5] + 0.02];

		this.octree = new Octree(bounds, viewer.settings.octreeDepth);
		this.lineBoxGeometry = new LineBoxGeometry(viewer, viewer.gl);
		
		this.loaderCounter = 0;
		this.loaderToNode = {};
		
		this.drawTileBorders = true;

		this._frustum = new Frustum();
		
		window.tilingRenderLayer = this;
		
		this.show = "none";
		this.initialLoad = "all";
	}
	
	showAll() {
		this.show = "all";
		this.viewer.dirty = true;
	}

	load(bimServerApi, densityThreshold, roids, progressListener) {
		var executor = new Executor(32);
		executor.setProgressListener(progressListener);
		var excludedTypes = ["IfcSpace", "IfcOpeningElement", "IfcAnnotation"];
		bimServerApi.call("ServiceInterface", "getTileCounts", {
			roids: roids,
			excludedTypes,
			geometryIdsToReuse: this.geometryDataToReuse,
			threshold: densityThreshold,
			depth: this.viewer.settings.octreeDepth
		}, (list) => {
			for (var i=0; i<list.length; i++) {
				var nrObjects = list[i];
				if (nrObjects == 0) {
					this.viewer.stats.inc("Tiling", "Empty tiles");
					continue;
				}
				this.viewer.stats.inc("Tiling", "Full tiles");
				var node = this.octree.getNodeById(i);
				node.nrObjects = nrObjects;
			}
			
			// TODO load per level, so first level 0, then 1 etc... These calls should be submitted to the executor only after the previous layer has been submitted
			// Mayeb we could load 2 levels at a time, to improve performance... So 0 and 1, as soon as 0 has loaded, start loading 2 etc...
			
			// Traversing breath-first so the big chucks are loaded first
//			for (var l=0; l<=this.octree.deepestLevel; l++) {
//				
//			}
			
			if (this.initialLoad == "all") {
				this.octree.traverseBreathFirst((node) => {
					if (node.nrObjects == 0) {
						// This happens for root nodes that don't contain any objects, but have children that do have objects
						return;
					}
					node.status = 0;
					node.liveBuffersTransparent = [];
					node.liveBuffersOpaque = [];
					node.liveReusedBuffers = [];
					
					node.stats = {
						triangles: 0,
						drawCallsPerFrame: 0
					};
	
					var bounds = node.getBounds();
					var query = {
						type: {
							name: "IfcProduct",
							includeAllSubTypes: true,
							exclude: excludedTypes
						},
						tiles: {
							ids: [node.id],
							densityUpperThreshold: densityThreshold,
							geometryDataToReuse: Array.from(this.geometryDataToReuse),
							maxDepth: this.viewer.settings.octreeDepth
						},
						include: {
							type: "IfcProduct",
							field: "geometry",
							include: {
								type: "GeometryInfo",
								field: "data"
							}
						},
						loaderSettings: JSON.parse(JSON.stringify(this.settings.loaderSettings))
					};
					
					if (this.viewer.vertexQuantization) {
						var map = {};
						for (var roid of roids) {
							map[roid] = this.viewer.vertexQuantization.getUntransformedVertexQuantizationMatrixForRoid(roid);
						}
					}
					
					// TODO this explodes when either the amount of roids gets high or the octree gets bigger, or both
					// TODO maybe it will be faster to just use one loader instead of potentially 180 loaders, this will however lead to more memory used because loaders can't be closed when they are done
					var geometryLoader = new GeometryLoader(this.loaderCounter++, bimServerApi, this, roids, this.viewer.settings.loaderSettings, map, this.viewer.stats, this.viewer.settings, query);
					this.registerLoader(geometryLoader.loaderId);
					this.loaderToNode[geometryLoader.loaderId] = node;
					geometryLoader.onStart = () => {
						node.status = 1;
						this.viewer.dirty = true;
					};
					executor.add(geometryLoader).then(() => {
						if (
								(node.liveBuffersOpaque == null || node.liveBuffersOpaque.length == 0) && 
								(node.liveBuffersTransparent == null || node.liveBuffersTransparent.length == 0) && 
								(node.liveReusedBuffers == null || node.liveReusedBuffers.length == 0) && 
								(node.bufferManager == null || node.bufferManager.bufferSets.size == 0)) {
							node.status = 0;
						} else {
							node.status = 2;
						}
						this.done(geometryLoader.loaderId);
					});
				});
			
				executor.awaitTermination().then(() => {
					this.completelyDone();
					this.octree.prepareBreathFirst((node) => {
						return true;
					});
					this.viewer.stats.requestUpdate();
					document.getElementById("progress").style.display = "none";
				});	
			}
		});
		return executor.awaitTermination();
	}

	render(transparency) {
		this.renderBuffers(transparency, false);
		this.renderBuffers(transparency, true);
	}
	
	occlude(node) {
		// 1. Are we always showing all objects?
		if (this.show == "all") {
			return false;
		}

		// 2. Is the complete Tile outside of the view frustum?
		var isect = this._frustum.intersectsWorldAABB(node.bounds);
		
		if (isect === Frustum.OUTSIDE_FRUSTUM) {
			return true;
		}
		
		// 3. In the tile too far away?
		var cameraEye = this.viewer.camera.eye;
		var tileCenter = node.getCenter();
		var sizeFactor = 1 / Math.pow(2, node.level);
		return vec3.distance(cameraEye, tileCenter) / sizeFactor > 1000000; // TODO use something related to the total bounding box size
//		console.log(cameraEye, tileCenter);
		// Default response
		return false;
	}
	
	renderBuffers(transparency, reuse) {
		// TODO when navigation is active (rotating, panning etc...), this would be the place to decide to for example not-render anything in this layer, or maybe apply more aggressive culling
//		if (this.viewer.navigationActive) {
//			return;
//		}
		
		var renderingTiles = 0;
		var renderingTriangles = 0;
		var drawCalls = 0;

		var programInfo = this.viewer.programManager.getProgram({
			instancing: reuse,
			useObjectColors: this.settings.useObjectColors,
			quantizeNormals: this.settings.quantizeNormals,
			quantizeVertices: this.settings.quantizeVertices
		});
		this.gl.useProgram(programInfo.program);
		// TODO find out whether it's possible to do this binding before the program is used (possibly just once per frame, and better yet, a different location in the code)
		this.gl.bindBufferBase(this.gl.UNIFORM_BUFFER, programInfo.uniformBlocks.LightData, this.viewer.lighting.lightingBuffer);
		
		this.gl.uniformMatrix4fv(programInfo.uniformLocations.projectionMatrix, false, this.viewer.camera.projMatrix);
		this.gl.uniformMatrix4fv(programInfo.uniformLocations.normalMatrix, false, this.viewer.camera.normalMatrix);
		this.gl.uniformMatrix4fv(programInfo.uniformLocations.modelViewMatrix, false, this.viewer.camera.viewMatrix);
		if (this.settings.quantizeVertices) {
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.vertexQuantizationMatrix, false, this.viewer.vertexQuantization.getTransformedInverseVertexQuantizationMatrix());
		}

		if (!transparency) { // Saves us from initializing two times per frame
			this._frustum.init(this.viewer.camera.viewMatrix, this.viewer.camera.projMatrix);
		}

		this.octree.traverseBreathFirstCached((node) => {
			// Check whether this node is completely outside of the view frustum -> discard
			// TODO results of these checks we could store for the second render pass (the transparency pass that is)

			// TODO at the moment a list (of non-empty tiles) is used to do traverseBreathFirst, but since a big optimization is possible by automatically culling 
			// child nodes of parent nodes that are culled, we might have to reconsider this and go back to tree-traversal, where returning false would indicate to 
			// skip the remaining child nodes

			if (this.occlude(node)) {
				node.visibilityStatus = 0;
				return;
			} else {
				node.visibilityStatus = 1;
				renderingTiles++;
	
				if (node.stats != null) {
					renderingTriangles += node.stats.triangles;
					drawCalls += node.stats.drawCallsPerFrame;
				}
			}
			
			var buffers = node.liveBuffersOpaque;
			if (transparency) {
				buffers = node.liveBuffersTransparent;
			}
			
			if (!reuse) {
				if (buffers != null && buffers.length > 0) {
					var lastUsedColorHash = null;
					
					for (let buffer of buffers) {
						if (this.settings.useObjectColors) {
							if (lastUsedColorHash == null || lastUsedColorHash != buffer.colorHash) {
								this.gl.uniform4fv(programInfo.uniformLocations.vertexColor, buffer.color);
								lastUsedColorHash = buffer.colorHash;
							}
						}
						this.renderBuffer(buffer, programInfo);
					}
				}
			}
			if (reuse) {
				if (node.liveReusedBuffers != null && node.liveReusedBuffers.length > 0) {
					var lastUsedColorHash = null;
					
					for (let buffer of node.liveReusedBuffers) {
						if (buffer.hasTransparency == transparency) {
							if (this.settings.useObjectColors) {
								if (lastUsedColorHash == null || lastUsedColorHash != buffer.colorHash) {
									this.gl.uniform4fv(programInfo.uniformLocations.vertexColor, buffer.color);
									lastUsedColorHash = buffer.colorHash;
								}
							}
							this.renderReusedBuffer(buffer, programInfo);
						}
					}
				}
			}
		});
		
		this.viewer.stats.setParameter("Drawing", "Draw calls per frame (L2)", drawCalls);
		this.viewer.stats.setParameter("Drawing", "Triangles to draw (L2)", renderingTriangles);
		
		this.viewer.stats.setParameter("Tiling", "Rendering tiles", renderingTiles);

		if (transparency && this.drawTileBorders) {
			// The lines are rendered in the transparency-phase only
			this.lineBoxGeometry.renderStart();
			this.octree.traverseBreathFirst((node) => {
				var color = null;
				if (node.status == 0) {
					
				} else if (node.status == 1) {
					color = [1, 0, 0, 0.5];
				} else if (node.status == 2) {
					if (node.visibilityStatus == 0) {
						color = [0, 1, 0, 0.5];
					} else if (node.visibilityStatus == 1) {
						color = [0, 0, 1, 0.5];
					}
				} else if (node.status == 3) {
					color = [0.5, 0.5, 0.5, 0.5];
				}
				if (color != null) {
					this.lineBoxGeometry.render(color, node.getMatrix());
				}
			});
			this.lineBoxGeometry.renderStop();
		}
	}

	renderBuffer(buffer, programInfo) {
		this.gl.bindVertexArray(buffer.vao);

		this.gl.drawElements(this.gl.TRIANGLES, buffer.nrIndices, this.gl.UNSIGNED_INT, 0);

		this.gl.bindVertexArray(null);
	}
	
	renderReusedBuffer(buffer, programInfo) {
		this.gl.bindVertexArray(buffer.vao);
		
		if (this.viewer.settings.quantizeVertices) {
			this.gl.uniformMatrix4fv(programInfo.uniformLocations.vertexQuantizationMatrix, false, this.viewer.vertexQuantization.getUntransformedInverseVertexQuantizationMatrixForRoid(buffer.roid));
		}
		this.gl.drawElementsInstanced(this.gl.TRIANGLES, buffer.nrIndices, buffer.indexType, 0, buffer.nrProcessedMatrices);

		this.gl.bindVertexArray(null);
	}
	
	addGeometry(loaderId, geometry, object) {
		var sizes = {
			vertices: geometry.positions.length,
			normals: geometry.normals.length,
			indices: geometry.indices.length,
			colors: (geometry.colors != null ? geometry.colors.length : 0)
		};
		
		// TODO some of this is duplicate code, also in defaultrenderlayer.js
		if (geometry.reused > 1 && this.geometryDataToReuse.has(geometry.id)) {
			geometry.matrices.push(object.matrix);
			
			this.viewer.stats.inc("Drawing", "Triangles to draw", geometry.indices.length / 3);

			return;
		}
		
		var node = this.loaderToNode[loaderId];
		
		if (node.bufferManager == null) {
			if (this.settings.useObjectColors) {
				node.bufferManager = new BufferManagerPerColor(this.viewer.settings, this, this.viewer.bufferSetPool);
			} else {
				node.bufferManager = new BufferManagerTransparencyOnly(this.viewer.settings, this, this.viewer.bufferSetPool);
			}
		}
		var buffer = node.bufferManager.getBufferSet(geometry.hasTransparency, geometry.color, sizes);
		buffer.node = node;
		
		super.addGeometry(loaderId, geometry, object, buffer, sizes);
	}
	
	createObject(loaderId, roid, oid, objectId, geometryIds, matrix, scaleMatrix, hasTransparency, type) {
		var loader = this.getLoader(loaderId);
		var node = this.loaderToNode[loaderId];
		var object = {
			id: objectId,
			visible: type != "IfcOpeningElement" && type != "IfcSpace",
			hasTransparency: hasTransparency,
			matrix: matrix,
			scaleMatrix: scaleMatrix,
			geometry: [],
			roid: roid,
//			object: this.viewer.model.objects[oid],
			add: (geometryId, objectId) => {
				this.addGeometryToObject(geometryId, objectId, loader, node.liveReusedBuffers);
			}
		};

		loader.objects.set(oid, object);

		geometryIds.forEach((id) => {
			this.addGeometryToObject(id, object.id, loader, node.liveReusedBuffers);
		});

		this.viewer.stats.inc("Models", "Objects");

		return object;
	}

	done(loaderId) {
		var loader = this.getLoader(loaderId);

		for (var geometry of loader.geometries.values()) {
			if (geometry.isReused) {
				this.addGeometryReusable(geometry, loader, node.liveReusedBuffers);
			}
		}

		var node = this.loaderToNode[loaderId];
		var bufferManager = node.bufferManager;
		if (bufferManager != null) {
			for (var buffer of bufferManager.getAllBuffers()) {
				this.flushBuffer(buffer);
			}
			bufferManager.clear();
			node.bufferManager = null;
		}

		for (var object of loader.objects.values()) {
			object.add = null;
		}
		
		for (var transparency of [false, true]) {
			var buffers = node.liveBuffersOpaque;
			if (transparency) {
				buffers = node.liveBuffersTransparent;
			}
			if (buffers.length > 1 && !this.viewer.settings.useObjectColors) {
				console.log("Combining buffers", buffers.length);
				// Optimize the buffers by combining them
				
				var nrPositions = 0;
				var nrNormals = 0;
				var nrIndices = 0;
				var nrColors = 0;
				
				for (var buffer of buffers) {
					nrPositions += buffer.nrPositions;
					nrNormals += buffer.nrNormals;
					nrIndices += buffer.nrIndices;
					nrColors += buffer.nrColors;
				}
				
				const positionBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
				this.gl.bufferData(this.gl.ARRAY_BUFFER, this.settings.quantizeVertices ? new Int16Array(nrPositions) : new Float32Array(nrPositions), this.gl.STATIC_DRAW);
				
				const normalBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
				this.gl.bufferData(this.gl.ARRAY_BUFFER, this.settings.quantizeNormals ? new Int8Array(nrNormals) : new Float32Array(nrNormals), this.gl.STATIC_DRAW);

				var colorBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
				this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(nrColors), this.gl.STATIC_DRAW);
				
				const indexBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
				this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, new Int32Array(nrIndices), this.gl.STATIC_DRAW);
				
				var positionsOffset = 0;
				var normalsOffset = 0;
				var indicesOffset = 0;
				var colorsOffset = 0;

				for (var buffer of buffers) {
					this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, buffer.positionBuffer);
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
					this.gl.copyBufferSubData(this.gl.COPY_READ_BUFFER, this.gl.ARRAY_BUFFER, 0, positionsOffset * (this.settings.quantizeVertices ? 2 : 4), buffer.nrPositions * (this.settings.quantizeVertices ? 2 : 4));
					
					this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, buffer.normalBuffer);
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
					this.gl.copyBufferSubData(this.gl.COPY_READ_BUFFER, this.gl.ARRAY_BUFFER, 0, normalsOffset * (this.settings.quantizeNormals ? 1 : 4), buffer.nrNormals * (this.settings.quantizeNormals ? 1 : 4));

					this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, buffer.colorBuffer);
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
					this.gl.copyBufferSubData(this.gl.COPY_READ_BUFFER, this.gl.ARRAY_BUFFER, 0, colorsOffset * 4, buffer.nrColors * 4);

					if (positionsOffset == 0) {
						this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, buffer.indexBuffer);
						this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
						this.gl.copyBufferSubData(this.gl.COPY_READ_BUFFER, this.gl.ELEMENT_ARRAY_BUFFER, 0, 0, buffer.nrIndices * 4);
					} else {
						var startIndex = positionsOffset / 3;
						
						this.gl.bindBuffer(this.gl.COPY_READ_BUFFER, buffer.indexBuffer);
						var tmpIndexBuffer = new Int32Array(buffer.nrIndices);
						this.gl.getBufferSubData(this.gl.COPY_READ_BUFFER, 0, tmpIndexBuffer, 0, buffer.nrIndices);
						
						for (var i=0; i<buffer.nrIndices; i++) {
							tmpIndexBuffer[i] = tmpIndexBuffer[i] + startIndex;
						}
						
						this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
						this.gl.bufferSubData(this.gl.ELEMENT_ARRAY_BUFFER, indicesOffset * 4, tmpIndexBuffer, 0, buffer.nrIndices);
					}

					this.gl.deleteBuffer(buffer.positionBuffer);
					this.gl.deleteBuffer(buffer.normalBuffer);
					this.gl.deleteBuffer(buffer.colorBuffer);
					this.gl.deleteBuffer(buffer.indexBuffer);
					
					this.gl.deleteVertexArray(buffer.vao);
					
					positionsOffset += buffer.nrPositions;
					normalsOffset += buffer.nrNormals;
					indicesOffset += buffer.nrIndices;
					colorsOffset += buffer.nrColors;
				}
				
				var programInfo = this.viewer.programManager.getProgram({
					instancing: false,
					useObjectColors: buffer.colors == null,
					quantizeNormals: this.settings.quantizeNormals,
					quantizeVertices: this.settings.quantizeVertices
				});
				
				var vao = this.gl.createVertexArray();
				this.gl.bindVertexArray(vao);

				{
					const numComponents = 3;
					const normalize = false;
					const stride = 0;
					const offset = 0;
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
					if (this.settings.quantizeVertices) {
						this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.SHORT, normalize, stride, offset);
					} else {
						this.gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.FLOAT, normalize, stride, offset);
					}
					this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
				}
				{
					const numComponents = 3;
					const normalize = false;
					const stride = 0;
					const offset = 0;
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
					if (this.settings.quantizeNormals) {
						this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.BYTE, normalize, stride, offset);
					} else {
						this.gl.vertexAttribPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.FLOAT, normalize, stride, offset);
					}
					this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexNormal);
				}
				
				if (buffer.colors != null) {
					const numComponents = 4;
					const type = this.gl.FLOAT;
					const normalize = false;
					const stride = 0;
					const offset = 0;
					this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
					this.gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, numComponents,	type, normalize, stride, offset);
					this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);
				}

				this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

				this.gl.bindVertexArray(null);
				
				var newBuffer = {
					positionBuffer: positionBuffer,
					normalBuffer: normalBuffer,
					indexBuffer: indexBuffer,
					colorBuffer: colorBuffer,
					nrIndices: indicesOffset,
					nrPositions: positionsOffset,
					nrNormals: normalsOffset,
					nrColors: colorsOffset,
					vao: vao,
					hasTransparency: transparency
				};
				
				this.viewer.stats.dec("Buffers", "Buffer groups", buffers.length);
				buffers.length = 0;
				buffers.push(newBuffer);
				this.viewer.stats.inc("Buffers", "Buffer groups", 1);
			}
		}

		this.removeLoader(loaderId);
	}

	flushAllBuffers() {
		this.octree.traverseBreathFirst((node) => {
			var bufferManager = node.bufferManager;
			if (bufferManager != null) {
				for (var buffer of bufferManager.getAllBuffers()) {
					this.flushBuffer(buffer);
				}
				if (this.settings.useObjectColors) {
					// When using object colors, it makes sense to sort the buffers by color, so we can potentially skip a few uniform binds
					// It might be beneficiary to do this sorting on-the-lfy and not just when everything is loaded

					// TODO disabled for now since we are testing combining buffer, which makes this obsolete
//					this.sortBuffers(node.liveBuffers);
				}
			}
		}, false);
	}
	
	flushBuffer(buffer) {
		if (buffer == null) {
			return;
		}
		if (buffer.nrIndices == 0) {
			return;
		}
		
		var node = buffer.node;
		
		var programInfo = this.viewer.programManager.getProgram({
			instancing: false,
			useObjectColors: buffer.colors == null,
			quantizeNormals: this.settings.quantizeNormals,
			quantizeVertices: this.settings.quantizeVertices
		});
		
		if (!this.settings.fakeLoading) {
			const positionBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.positions, this.gl.STATIC_DRAW, 0, buffer.positionsIndex);

			const normalBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
			this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.normals, this.gl.STATIC_DRAW, 0, buffer.normalsIndex);

			if (buffer.colors != null) {
				var colorBuffer = this.gl.createBuffer();
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
				this.gl.bufferData(this.gl.ARRAY_BUFFER, buffer.colors, this.gl.STATIC_DRAW, 0, buffer.colorsIndex);
			}

			const indexBuffer = this.gl.createBuffer();
			this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
			this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, buffer.indices, this.gl.STATIC_DRAW, 0, buffer.indicesIndex);

			var vao = this.gl.createVertexArray();
			this.gl.bindVertexArray(vao);

			{
				const numComponents = 3;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, positionBuffer);
				if (this.settings.quantizeVertices) {
					this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.SHORT, normalize, stride, offset);
				} else {
					this.gl.vertexAttribPointer(programInfo.attribLocations.vertexPosition, numComponents, this.gl.FLOAT, normalize, stride, offset);
				}
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexPosition);
			}
			{
				const numComponents = 3;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, normalBuffer);
				if (this.settings.quantizeNormals) {
					this.gl.vertexAttribIPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.BYTE, normalize, stride, offset);
				} else {
					this.gl.vertexAttribPointer(programInfo.attribLocations.vertexNormal, numComponents, this.gl.FLOAT, normalize, stride, offset);
				}
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexNormal);
			}
			
			if (buffer.colors != null) {
				const numComponents = 4;
				const type = this.gl.FLOAT;
				const normalize = false;
				const stride = 0;
				const offset = 0;
				this.gl.bindBuffer(this.gl.ARRAY_BUFFER, colorBuffer);
				this.gl.vertexAttribPointer(programInfo.attribLocations.vertexColor, numComponents,	type, normalize, stride, offset);
				this.gl.enableVertexAttribArray(programInfo.attribLocations.vertexColor);
			}

			this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

			this.gl.bindVertexArray(null);

			var newBuffer = {
				positionBuffer: positionBuffer,
				normalBuffer: normalBuffer,
				indexBuffer: indexBuffer,
				nrIndices: buffer.nrIndices,
				nrPositions: buffer.positionsIndex,
				nrNormals: buffer.normalsIndex,
				nrColors: buffer.colorsIndex,
				vao: vao,
				hasTransparency: buffer.hasTransparency
			};
			
			if (buffer.colors != null) {
				newBuffer.colorBuffer = colorBuffer;
			}
			
			if (this.settings.useObjectColors) {
				newBuffer.color = [buffer.color.r, buffer.color.g, buffer.color.b, buffer.color.a];
				newBuffer.colorHash = Utils.hash(JSON.stringify(buffer.color));
			}
			
			if (newBuffer.hasTransparency) {
				node.liveBuffersTransparent.push(newBuffer);
			} else {
				node.liveBuffersOpaque.push(newBuffer);
			}
		}

		var toadd = buffer.positionsIndex * (this.settings.quantizeVertices ? 2 : 4) + buffer.normalsIndex * (this.settings.quantizeNormals ? 1 : 4) + (buffer.colorsIndex != null ? buffer.colorsIndex * 4 : 0) + buffer.indicesIndex * 4;

		this.viewer.stats.inc("Primitives", "Nr primitives loaded", buffer.nrIndices / 3);
		if (this.progressListener != null) {
			this.progressListener(this.viewer.stats.get("Primitives", "Nr primitives loaded") + this.viewer.stats.get("Primitives", "Nr primitives hidden"));
		}
		this.viewer.stats.inc("Data", "GPU bytes", toadd);
		this.viewer.stats.inc("Data", "GPU bytes total", toadd);
		this.viewer.stats.inc("Buffers", "Buffer groups");
		
		node.stats.triangles += buffer.nrIndices / 3;
		node.stats.drawCallsPerFrame++;

		node.bufferManager.resetBuffer(buffer);
		this.viewer.dirty = true;
	}
	
	completelyDone() {
		this.flushAllBuffers();
		this.viewer.dirty = true;
	}
}