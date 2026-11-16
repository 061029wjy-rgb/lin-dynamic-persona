import { Controller } from './src/controller.js';
import { Panel, recoveryDialog } from './src/ui.js';
const INSTANCE = Symbol.for('lin-dynamic-persona.instance.v1');
let controller, panel;
let panelUpdateTimer;
export function onDisable() {
    clearTimeout(panelUpdateTimer); panelUpdateTimer = null;
    controller?.dispose(); panel?.dispose(); controller = null; panel = null;
    if (globalThis[INSTANCE] === onDisable) delete globalThis[INSTANCE];
    delete globalThis.linDynamicPersonaIntercept;
}
export function onEnable() {
    if (!globalThis.SillyTavern?.getContext) return;
    globalThis[INSTANCE]?.(); globalThis[INSTANCE] = onDisable;
    controller = new Controller(() => SillyTavern.getContext(), { update: () => { if(panelUpdateTimer)return; panelUpdateTimer=setTimeout(()=>{panelUpdateTimer=null;panel?.mount();panel?.render();},0); }, recovery: recoveryDialog });
    panel = new Panel(controller); panel.mount(); controller.bind();
    globalThis.linDynamicPersonaIntercept = async (chat, contextSize, abort, type) => {
        try { await controller?.intercept(chat, contextSize, abort, type); }
        catch (e) { controller?.fail(e); }
    };
    controller.enqueue(() => controller.sync({ recovery: true })).catch(() => {});
}
onEnable();
