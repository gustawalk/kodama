export type Entry = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};
export type Variable = {
  id: string;
  name: string;
  value: string;
  secret: boolean;
};
export type Auth = {
  kind: string;
  username: string;
  password: string;
  token: string;
};
export type Body = { kind: string; text: string; fields: Entry[] };
export type ApiRequest = {
  id: string;
  name: string;
  method: string;
  url: string;
  folderId: string | null;
  query: Entry[];
  headers: Entry[];
  auth: Auth;
  body: Body;
  preScript: string;
  postScript: string;
  trusted: boolean;
  timeoutMs: number | null;
};
export type Folder = { id: string; name: string; parentId: string | null };
export type Collection = {
  id: string;
  name: string;
  variables: Variable[];
  folders: Folder[];
  requests: ApiRequest[];
};
export type Environment = { id: string; name: string; variables: Variable[] };
export type Store = {
  version: number;
  defaults: Variable[];
  collections: Collection[];
  environments: Environment[];
  activeEnvironmentId: string | null;
};
export type RunResult = {
  url: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  binary: boolean;
  size: number;
  elapsedMs: number;
  runtimeVariables: Record<string, string>;
};

export const uid = () => crypto.randomUUID();
export const entry = (): Entry => ({
  id: uid(),
  key: "",
  value: "",
  enabled: true,
});
export const variable = (): Variable => ({
  id: uid(),
  name: "",
  value: "",
  secret: false,
});
export const newRequest = (
  name = "New request",
  folderId: string | null = null,
): ApiRequest => ({
  id: uid(),
  name,
  method: "GET",
  url: "",
  folderId,
  query: [],
  headers: [],
  auth: { kind: "none", username: "", password: "", token: "" },
  body: { kind: "json", text: "", fields: [] },
  preScript: "",
  postScript: "",
  trusted: true,
  timeoutMs: null,
});
export const newCollection = (name = "New collection"): Collection => ({
  id: uid(),
  name,
  variables: [],
  folders: [],
  requests: [],
});

export function demoStore(): Store {
  const collection = newCollection("Kodama demo");
  const environment: Environment = {
    id: uid(),
    name: "Local demo",
    variables: [{
      id: uid(),
      name: "BASE_URL",
      value: "http://127.0.0.1:8787",
      secret: false,
    }],
  };
  const login = newRequest("Login");
  login.method = "POST";
  login.url = "{{BASE_URL}}/login";
  login.body = {
    kind: "json",
    text: '{"username":"demo","password":"demo"}',
    fields: [],
  };
  login.postScript = "_.TOKEN = response.json().token;";
  const protectedRequest = newRequest("Protected route");
  protectedRequest.url = "{{BASE_URL}}/protected";
  protectedRequest.headers = [{
    id: uid(),
    key: "Authorization",
    value: "Bearer {{_.TOKEN}}",
    enabled: true,
  }];
  collection.requests = [login, protectedRequest];
  return {
    version: 1,
    defaults: [],
    collections: [collection],
    environments: [environment],
    activeEnvironmentId: environment.id,
  };
}
