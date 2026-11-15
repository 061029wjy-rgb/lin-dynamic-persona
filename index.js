import { Controller } from './src/controller.js';
import { Panel, recoveryDialog } from './src/ui.js';
const INSTANCE = Symbol.for('lin-dynamic-persona.instance.v1');
let controller, panel;
export function onDisable() {
    controller?.dispose(); panel?.dispose(); controller = null; panel = null;
    if (globalThis[INSTANCE] === onDisable) delete globalThis[INSTANCE];
    delete globalThis.linDynamicPersonaIntercept;
}
export function onEnable() {
    if (!globalThis.SillyTavern?.getContext) return;
    globalThis[INSTANCE]?.(); globalThis[INSTANCE] = onDisable;
    controller = new Controller(() => SillyTavern.getContext(), { update: () => { panel?.mount(); panel?.render(); }, recovery: recoveryDialog });
    panel = new Panel(controller); panel.mount(); controller.bind();
    globalThis.linDynamicPersonaIntercept = (...args) => controller?.intercept(...args).catch(e => controller?.fail(e));
    controller.enqueue(() => controller.sync({ recovery: true })).catch(() => {});
}
onEnable();
