import { describe,it,expect } from 'vitest';
import { isProductionDocument,isProductionPrompt,type ProductionShot } from './customized-production';
import { validateStoryboardPublication } from './customized-storyboard-generation';
const asset={id:'cup',kind:'PRODUCT',name:'杯子',description:'陶瓷杯',knownFacts:'陶瓷',designNotes:'颜色待设计',sourceText:'简报中的陶瓷杯'};
const shot:ProductionShot={id:'s1',title:'倒水',visual:'水倒入杯中',shotType:'特写',cameraMovement:'固定',durationSeconds:5,dialogue:'',audio:'水声',atmosphere:'清晨',bindings:[{assetId:'cup',description:'杯身正面'}]};
describe('customized production boundaries',()=>{
  it('validates untrusted shape without throwing',()=>{for(const value of [null,{}, {assets:[asset],shots:[null]}, {assets:[null],shots:[]}]) expect(isProductionDocument(value)).toBe(false);});
  it('rejects unknown and duplicate bindings',()=>{expect(isProductionDocument({assets:[asset],shots:[shot]})).toBe(true);expect(isProductionDocument({assets:[asset],shots:[{...shot,bindings:[{assetId:'other',description:''}]}]})).toBe(false);expect(isProductionDocument({assets:[asset],shots:[{...shot,bindings:[...shot.bindings,...shot.bindings]}]})).toBe(false);});
  it('prompt uses exactly the bound subset, not the entire directory',()=>{expect(isProductionPrompt({shotId:'s1',content:'杯中倒水',assetIds:['cup']},shot)).toBe(true);expect(isProductionPrompt({shotId:'s1',content:'杯中倒水',assetIds:['cup','person']},shot)).toBe(false);expect(isProductionPrompt({shotId:'s1',content:'杯中倒水',assetIds:[]},shot)).toBe(false);});
  it('publishes complete stories without prematurely requiring shots or assets',()=>{expect(validateStoryboardPublication({id:'story',name:'一杯清晨',synopsis:'归家喝水',structure:'开始、发展、收束',productFocus:'陶瓷杯',shots:[],assets:[],story:{content:'打开窗，把水倒入杯中，坐下阅读。',opening:'开窗',development:'倒水',ending:'阅读',dialoguePlan:'无',beats:[{id:'b1',content:'开窗倒水阅读',durationSeconds:30}]}},30)).toBeNull();});
});
