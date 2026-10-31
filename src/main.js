import {ArchiveApp} from './app.js';
// Tampermonkey asynchronous storage supports read-back confirmation and error reporting.
const storage = {
  get: (key,fallback)=>GM.getValue(key,fallback),
  set: (key,value)=>GM.setValue(key,value),
  list: ()=>GM.listValues(),
  listen: (key,callback)=>GM.addValueChangeListener(key,callback),
  unlisten: id=>GM.removeValueChangeListener(id),
  menu: (name,callback)=>GM.registerMenuCommand(name,callback)
};
new ArchiveApp(storage).start().catch(error=> {
  console.error('[Forum Archive] Initialization failed; existing storage was not cleared.');
  alert(`Forum Archive 启动失败：${error.message}\n已有收藏未被清空。请检查 Tampermonkey 权限后刷新。`);
});
