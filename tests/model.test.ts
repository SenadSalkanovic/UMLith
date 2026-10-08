import {describe,it,expect} from 'vitest';
import {GraphSchema,NodeSchema,graphDelta} from '../shared/model';
describe('program graph',()=>{
 it('rejects cycles, duplicates and dangling relationships',()=>{
  const a=NodeSchema.parse({id:'a',kind:'module',name:'A',parentId:'b'});
  const b=NodeSchema.parse({id:'b',kind:'module',name:'B',parentId:'a'});
  expect(GraphSchema.safeParse({nodes:[a,b],edges:[]}).success).toBe(false);
  expect(GraphSchema.safeParse({nodes:[{...a,parentId:undefined}, {...a,parentId:undefined}],edges:[]}).success).toBe(false);
  expect(GraphSchema.safeParse({nodes:[],edges:[{id:'e',source:'a',target:'b',kind:'calls'}]}).success).toBe(false);
 });
 it('reports changed and removed nodes instead of a whole replacement',()=>{
  const a=NodeSchema.parse({id:'a',kind:'function',name:'Old'});
  const b=NodeSchema.parse({id:'b',kind:'function',name:'Removed'});
  expect(graphDelta({nodes:[a,b],edges:[]},{nodes:[{...a,name:'New'}],edges:[]})).toMatchObject({changedNodes:[{id:'a',name:'New'}],deletedNodes:['b']});
 });
});
