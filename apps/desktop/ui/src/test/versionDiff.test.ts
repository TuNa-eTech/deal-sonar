import {describe,it,expect} from "vitest";
import {describeChanges,formatVersionTime} from "../lib/versionDiff";
import type {RadarVersion} from "../types/ipc";

const base:RadarVersion={id:"a",radar_id:"r",version:1,description:"Tìm phòng trọ",language_hint:null,user_profession:null,created_at:0,
 fields:[{key:"price",label:"Giá",type:"number",description:"",required:false,options:null,show_in_alert:true,order:0}],
 match_policy:{want_intent:"supply",exclude_roles:[],hard_filters:[{field:"price",op:"lte",value:5000000,when_missing:"pass"}]}};

describe("describeChanges",()=>{
 it("returns nothing for identical definitions",()=>expect(describeChanges(base,{...base,version:2})).toEqual([]));
 it("describes goal, field and filter changes in plain language",()=>{
  const next:RadarVersion={...base,version:2,description:"Tìm căn hộ mini",
   fields:[...base.fields,{...base.fields[0]!,key:"district",label:"Quận"}],
   match_policy:{...base.match_policy,hard_filters:[{field:"price",op:"lte",value:8000000,when_missing:"pass"}]}};
  const out=describeChanges(base,next);
  expect(out).toContain("Mục tiêu: “Tìm phòng trọ” → “Tìm căn hộ mini”");
  expect(out).toContain("Thêm thông tin cần lấy: Quận");
  expect(out.some(l=>l.startsWith("Điều kiện: Giá ≤ 5.000.000 → Giá ≤ 8.000.000"))).toBe(true);
 });
});
describe("formatVersionTime",()=>{
 it("uses relative day names",()=>{
  const now=new Date(2026,10,13,15,0).getTime();
  expect(formatVersionTime(new Date(2026,10,13,9,5).getTime(),now)).toMatch(/^Hôm nay/);
  expect(formatVersionTime(new Date(2026,10,12,9,5).getTime(),now)).toMatch(/^Hôm qua/);
 });
});
