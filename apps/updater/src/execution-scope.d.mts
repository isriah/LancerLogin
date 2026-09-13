export interface ExecutionScope {
  readonly permitId: string;
  readonly done: Promise<{status:string}>;
  run<T>(handler: (scope:ExecutionScope)=>T|Promise<T>): Promise<T>;
  waitUntil(promise:Promise<unknown>):void;
  track<T>(promise:Promise<T>):Promise<T>;
  guard<T extends unknown[],R>(fn:(...args:T)=>R|Promise<R>):(...args:T)=>Promise<R>;
  mutation<T extends unknown[],R>(kind:string,dispatch:(operation:{operationId:string;permitId:string;epoch:number},...args:T)=>R|Promise<R>,isDefinitive?:(result:R)=>boolean|Promise<boolean>):(...args:T)=>Promise<R>;
  wrapD1<T>(database:T):T;
}
export function admitExecutionScope(options:{core:unknown;capability:object;permitId?:string}):Promise<ExecutionScope|null>;
