/****************************************************************************
 Copyright (c) 2021-2023 Xiamen Yaji Software Co., Ltd.

 http://www.cocos.com

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
****************************************************************************/
import { DEBUG } from 'internal:constants';
import { Buffer, Framebuffer, LoadOp, StoreOp, Texture, Viewport } from '../../gfx';
import { VectorGraphColorMap } from './effect';
import { DefaultVisitor, depthFirstSearch, ReferenceGraphView } from './graph';
import { LayoutGraphData } from './layout-graph';
import { BasicPipeline } from './pipeline';
import {
    Blit, ClearView, ComputePass, ComputeSubpass, CopyPass, Dispatch, FormatView, ManagedBuffer, ManagedResource, ManagedTexture, MovePass,
    RasterPass, RasterSubpass, RaytracePass, RenderGraph, RenderGraphVisitor, RasterView, ComputeView,
    RenderQueue, RenderSwapchain, ResolvePass, ResourceGraph, ResourceGraphVisitor, SceneData, SubresourceView, PersistentBuffer, PersistentTexture,
    RenderGraphValue,
} from './render-graph';
import { AccessType, ResourceResidency, SceneFlags } from './types';
import { hashCombineKey, hashCombineStr } from './define';

function genHashValue (pass: RasterPass): void {
    let hashCode = '';
    for (const [name, raster] of pass.rasterViews) {
        hashCode += hashCombineKey(name);
        hashCode += hashCombineKey(raster.slotName);
        hashCode += hashCombineKey(raster.accessType);
        hashCode += hashCombineKey(raster.attachmentType);
        hashCode += hashCombineKey(raster.loadOp);
        hashCode += hashCombineKey(raster.storeOp);
        hashCode += hashCombineKey(raster.clearFlags);
        hashCode += hashCombineKey(raster.clearColor.x);
        hashCode += hashCombineKey(raster.clearColor.y);
        hashCode += hashCombineKey(raster.clearColor.z);
        hashCode += hashCombineKey(raster.clearColor.w);
        hashCode += hashCombineKey(raster.slotID);
        hashCode += hashCombineKey(raster.shaderStageFlags);
    }
    for (const [name, computes] of pass.computeViews) {
        hashCode += hashCombineKey(name);
        for (const compute of computes) {
            hashCode += hashCombineKey(compute.name);
            hashCode += hashCombineKey(compute.accessType);
            hashCode += hashCombineKey(compute.clearFlags);
            hashCode += hashCombineKey(compute.clearValueType);
            hashCode += hashCombineKey(compute.clearValue.x);
            hashCode += hashCombineKey(compute.clearValue.y);
            hashCode += hashCombineKey(compute.clearValue.z);
            hashCode += hashCombineKey(compute.clearValue.w);
            hashCode += hashCombineKey(compute.shaderStageFlags);
        }
    }
    hashCode += hashCombineKey(pass.width);
    hashCode += hashCombineKey(pass.height);
    hashCode += hashCombineKey(pass.viewport.left);
    hashCode += hashCombineKey(pass.viewport.top);
    hashCode += hashCombineKey(pass.viewport.width);
    hashCode += hashCombineKey(pass.viewport.height);
    hashCode += hashCombineKey(pass.viewport.minDepth);
    hashCode += hashCombineKey(pass.viewport.maxDepth);
    hashCode += hashCombineKey(pass.showStatistics ? 1 : 0);
    pass.hashValue = hashCombineStr(hashCode);
}
const readViews: Map<string, RasterView> = new Map();
class PassVisitor implements RenderGraphVisitor {
    public queueID = 0xFFFFFFFF;
    public sceneID = 0xFFFFFFFF;
    public passID = 0xFFFFFFFF;
    public dispatchID = 0xFFFFFFFF;
    // output resourcetexture id
    public resID = 0xFFFFFFFF;
    public context: CompilerContext;
    private _currPass: RasterPass | CopyPass | ComputePass | null = null;
    private _resVisitor: ResourceVisitor;
    constructor (context: CompilerContext) {
        this.context = context;
        this._resVisitor = new ResourceVisitor(this.context);
    }
    protected _isRasterPass (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.RasterPass, u);
    }
    protected _isCopyPass (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Copy, u);
    }
    protected _isCompute (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Compute, u);
    }
    protected _isDispatch (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Dispatch, u);
    }
    protected _isQueue (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Queue, u);
    }
    protected _isShadowMap (u: number): boolean {
        const sceneData = this._getSceneData(u);
        if (sceneData) {
            return sceneData.light && !!sceneData.light.light && (sceneData.flags & SceneFlags.SHADOW_CASTER) !== 0;
        }
        return false;
    }
    protected _getSceneData (u: number): SceneData | null {
        if (!this.context.renderGraph.h(RenderGraphValue.Scene, u)) {
            return null;
        }
        return this.context.renderGraph.j<SceneData>(u);
    }
    protected _isScene (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Scene, u);
    }
    protected _isBlit (u: number): boolean {
        return this.context.renderGraph.h(RenderGraphValue.Blit, u);
    }

    private _useResourceInfo (input: string, raster: RasterView): void {
        if (!DEBUG) {
            return;
        }
        const resContext = this.context.resourceContext;
        const useContext = resContext.get(input);
        const resGraph = this.context.resourceGraph;
        // There are resources being used
        if (useContext) {
            const rasters = useContext.rasters;
            const passRaster = rasters.get(this.passID);
            if (passRaster === raster) {
                return;
            }
            const computes = useContext.computes;
            let isPreRaster = false;
            for (const [passId, currRaster] of rasters) {
                if (passId > this.passID) {
                    isPreRaster = true;
                }
            }
            for (const [passId] of computes) {
                if (passId > this.passID) {
                    isPreRaster = true;
                    break;
                }
            }
            rasters.set(this.passID, raster);
        } else {
            const resId = resGraph.vertex(input);
            const trait = resGraph.getTraits(resId);
            switch (trait.residency) {
            case ResourceResidency.PERSISTENT:
                break;
            default:
            }
            const useContext = new ResourceUseContext();
            resContext.set(input, useContext);
            useContext.rasters.set(this.passID, raster);
        }
    }

    private _fetchValidPass (): void {
        const rg = this.context.renderGraph;
        const resContext = this.context.resourceContext;
        if (!DEBUG && rg.getValid(this.passID)) {
            rg.setValid(this.queueID, true);
            rg.setValid(this.sceneID, true);
            return;
        }
        const outputId = this.resID;
        const outputName = this.context.resourceGraph.vertexName(outputId);
        readViews.clear();
        const pass = this._currPass! as RasterPass;
        const validPass = rg.getValid(this.passID);
        for (const [readName, raster] of pass.rasterViews) {
            // find the pass
            if (readName === outputName
                && raster.accessType !== AccessType.READ) {
                if (DEBUG) {
                    this._useResourceInfo(readName, raster);
                }
                rg.setValid(this.passID, true);
                rg.setValid(this.queueID, true);
                rg.setValid(this.sceneID, true);
                continue;
            }
            if (raster.accessType !== AccessType.WRITE) {
                readViews.set(readName, raster);
            }
        }
        if (DEBUG && validPass) return;
        if (rg.getValid(this.sceneID)) {
            for (const [readName, raster] of pass.rasterViews) {
                context.pipeline.resourceUses.push(readName);
            }
            let resourceGraph;
            let vertID;
            for (const [rasterName, raster] of readViews) {
                resourceGraph = this.context.resourceGraph;
                vertID = resourceGraph.find(rasterName);
                if (vertID !== 0xFFFFFFFF) {
                    this._resVisitor.resID = vertID;
                    resourceGraph.visitVertex(this._resVisitor, vertID);
                }
            }
            for (const [computeName, cViews] of pass.computeViews) {
                if (DEBUG) {
                    let resUseContext = resContext.get(computeName);
                    if (!resUseContext) {
                        resUseContext = new ResourceUseContext();
                        resContext.set(computeName, resUseContext);
                    }
                    const computes = resUseContext.computes;
                    const currUseComputes = computes.get(this.passID);
                    if (currUseComputes) {
                        currUseComputes.push(cViews);
                    } else {
                        computes.set(this.passID, [cViews]);
                    }
                }
                resourceGraph = this.context.resourceGraph;
                vertID = resourceGraph.find(computeName);
                if (vertID !== 0xFFFFFFFF) {
                    this._resVisitor.resID = vertID;
                    resourceGraph.visitVertex(this._resVisitor, vertID);
                }
            }
            genHashValue(pass);
        }
    }
    applyID (id: number, resId: number): void {
        this.resID = resId;
        if (this._isRasterPass(id) || this._isCopyPass(id) || this._isCompute(id)) {
            this.passID = id;
        } else if (this._isQueue(id)) {
            this.queueID = id;
        } else if (this._isScene(id) || this._isBlit(id)) {
            this.sceneID = id;
        } else if (this._isDispatch(id)) {
            this.dispatchID = id;
        }
    }
    rasterPass (pass: RasterPass): void {
        // const rg = this.context.renderGraph;
        // Since the pass is valid, there is no need to continue traversing.
        // if (rg.getValid(this.passID)) {
        //     return;
        // }
        this._currPass = pass;
    }
    rasterSubpass (value: RasterSubpass): void {
        // noop
    }
    computeSubpass (value: ComputeSubpass): void {
        // noop
    }
    compute (value: ComputePass): void {
        this._currPass = value;
        const rg = context.renderGraph;
        rg.setValid(this.passID, true);
    }
    resolve (value: ResolvePass): void {
        // noop
    }
    copy (value: CopyPass): void {
        const rg = context.renderGraph;
        if (rg.getValid(this.passID)) {
            return;
        }
        const resourceGraph = this.context.resourceGraph;
        this._currPass = value;
        const outputId = this.resID;
        const outputName = resourceGraph.vertexName(outputId);
        let vertID: number;
        for (const pair of value.copyPairs) {
            if (pair.target === outputName) {
                rg.setValid(this.passID, true);
                vertID = resourceGraph.find(pair.source);
                if (vertID !== 0xFFFFFFFF) {
                    this._resVisitor.resID = vertID;
                    resourceGraph.visitVertex(this._resVisitor, vertID);
                }
            }
        }
    }
    move (value: MovePass): void {
        // noop
    }
    raytrace (value: RaytracePass): void {
        // noop
    }
    queue (value: RenderQueue): void {
        // noop
    }
    scene (value: SceneData): void {
        this._fetchValidPass();
    }
    blit (value: Blit): void {
        this._fetchValidPass();
    }
    dispatch (value: Dispatch): void {
        const rg = this.context.renderGraph;
        rg.setValid(this.queueID, true);
        rg.setValid(this.dispatchID, true);
    }
    clear (value: ClearView[]): void {
        // noop
    }
    viewport (value: Viewport): void {
        // noop
    }
}

class PassManagerVisitor extends DefaultVisitor {
    private _colorMap: VectorGraphColorMap;
    private _graphView: ReferenceGraphView<RenderGraph>;
    private _passVisitor: PassVisitor;
    private _resId = 0xFFFFFFFF;

    set resId (value: number) {
        this._resId = value;
        this._colorMap.colors.length = context.renderGraph.nv();
    }
    get resId (): number {
        return this._resId;
    }
    constructor (context: CompilerContext, resId: number) {
        super();
        this._resId = resId;
        this._passVisitor = new PassVisitor(context);
        this._graphView = new ReferenceGraphView<RenderGraph>(context.renderGraph);
        this._colorMap = new VectorGraphColorMap(context.renderGraph.nv());
    }
    get graphView (): ReferenceGraphView<RenderGraph> { return this._graphView; }
    get colorMap (): VectorGraphColorMap { return this._colorMap; }
    discoverVertex (u: number, gv: ReferenceGraphView<RenderGraph>): void {
        const g = gv.g;
        this._passVisitor.applyID(u, this.resId);
        g.visitVertex(this._passVisitor, u);
    }
}

class ResourceVisitor implements ResourceGraphVisitor {
    private readonly _context: CompilerContext;
    public resID = 0xFFFFFFFF;
    private _passManagerVis!: PassManagerVisitor;
    constructor (context: CompilerContext) {
        this._context = context;
    }
    managedBuffer (value: ManagedBuffer): void {
        // noop
    }
    managedTexture (value: ManagedTexture): void {
        // noop
    }
    managed (value: ManagedResource): void {
        this.dependency();
    }
    persistentBuffer (value: Buffer | PersistentBuffer): void {
        // noop
    }

    dependency (): void {
        if (!this._passManagerVis) {
            this._passManagerVis = new PassManagerVisitor(this._context, this.resID);
        } else {
            this._passManagerVis.resId = this.resID;
        }
        depthFirstSearch(this._passManagerVis.graphView, this._passManagerVis, this._passManagerVis.colorMap);
    }

    persistentTexture (value: Texture | PersistentTexture): void {
        this.dependency();
    }
    framebuffer (value: Framebuffer): void {
        this.dependency();
    }
    swapchain (value: RenderSwapchain): void {
        this.dependency();
    }
    formatView (value: FormatView): void {
        // noop
    }
    subresourceView (value: SubresourceView): void {
        // noop
    }
}

class ResourceUseContext {
    // <passID, pass view>
    readonly rasters: Map<number, RasterView> = new Map<number, RasterView>();
    // <pass Use ID, compute views>
    computes: Map<number, [ComputeView[]]> = new Map<number, [ComputeView[]]>();
}
class CompilerContext {
    set (
        pipeline: BasicPipeline,
        resGraph: ResourceGraph,
        renderGraph: RenderGraph,
        layoutGraph: LayoutGraphData,
    ): void {
        this.pipeline = pipeline;
        this.resourceGraph = resGraph;
        this.renderGraph = renderGraph;
        this.layoutGraph = layoutGraph;
        if (!this.resourceContext) {
            this.resourceContext = new Map<string, ResourceUseContext>();
        }
        this.resourceContext.clear();
    }
    resourceGraph!: ResourceGraph;
    pipeline;
    renderGraph!: RenderGraph;
    layoutGraph!: LayoutGraphData;
    resourceContext!: Map<string, ResourceUseContext>;
}

export class Compiler {
    private _resourceGraph: ResourceGraph;
    private _pipeline: BasicPipeline;
    private _layoutGraph: LayoutGraphData;
    private _visitor: ResourceManagerVisitor;
    constructor (
        pipeline: BasicPipeline,
        renderGraph: RenderGraph,
        resGraph: ResourceGraph,
        layoutGraph: LayoutGraphData,
    ) {
        this._pipeline = pipeline;
        this._resourceGraph = resGraph;
        this._layoutGraph = layoutGraph;
        context.set(this._pipeline, this._resourceGraph, renderGraph, this._layoutGraph);
        this._visitor = new ResourceManagerVisitor(context);
    }
    compile (rg: RenderGraph): void {
        context.set(this._pipeline, this._resourceGraph, rg, this._layoutGraph);
        context.pipeline.resourceUses.length = 0;
        this._visitor.colorMap.colors.length = context.resourceGraph.nv();
        depthFirstSearch(this._resourceGraph, this._visitor, this._visitor.colorMap);
    }
}
const context = new CompilerContext();
export class ResourceManagerVisitor extends DefaultVisitor {
    private _colorMap: VectorGraphColorMap;
    private _resourceGraph: ResourceGraph;
    private _resVisitor: ResourceVisitor;
    constructor (context: CompilerContext) {
        super();
        this._colorMap = new VectorGraphColorMap(context.resourceGraph.nv());
        this._resourceGraph = context.resourceGraph;
        this._resVisitor = new ResourceVisitor(context);
    }
    get colorMap (): VectorGraphColorMap { return this._colorMap; }
    discoverVertex (u: number, gv: ResourceGraph): void {
        const traits = this._resourceGraph.getTraits(u);
        if (traits.residency === ResourceResidency.MANAGED
                || traits.residency === ResourceResidency.MEMORYLESS) {
            return;
        }
        this._resVisitor.resID = u;
        this._resourceGraph.visitVertex(this._resVisitor, u);
    }
}