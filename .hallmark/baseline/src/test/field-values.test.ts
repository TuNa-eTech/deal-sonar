import {describe,it,expect} from "vitest";
import {parseFieldValue,parseVietnameseNumber,localDateTime} from "../lib/fieldValues";
import type {FieldDef} from "../types/ipc";
const field:FieldDef={key:"price",label:"Giá",type:"money",description:"",required:false,options:null,show_in_alert:true,order:1};
describe("Manual corrections preserve business values",()=>{
 it("normalizes Vietnamese units and ranges without losing millions",()=>{
  expect(parseFieldValue(field,"15 triệu/tháng")).toEqual({min:15000000,max:15000000,currency:"VND",period:"month"});
  expect(parseFieldValue(field,"12–14 triệu/tháng")).toEqual({min:12000000,max:14000000,currency:"VND",period:"month"});
  expect(parseVietnameseNumber("15.000.000")).toBe(15000000);
  expect(()=>parseFieldValue(field,"14–12 triệu")).toThrow();
  expect(()=>parseVietnameseNumber("abc")).toThrow();
 });
 it("keeps local follow-up time stable after reopening",()=>{
  const time=new Date(2026,10,14,15,0).getTime();
  expect(localDateTime(time)).toBe("2026-11-14T15:00");
  expect(new Date(localDateTime(time)).getTime()).toBe(time);
 });
});
