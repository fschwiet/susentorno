local PLACEHOLDER = "Bearer sk-ant-oat-susentorno-PLACEHOLDER"
local NO_AUTH_MARKER = "x-susentorno-no-auth"
local NO_AUTH_SENTINEL = "susentorno-no-credential"
local NO_ACCOUNT_ID_MARKER = "x-susentorno-no-account-id"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
  headers:remove(NO_ACCOUNT_ID_MARKER)
  local auth = headers:get("authorization")
  if auth == nil then
    headers:replace("authorization", NO_AUTH_SENTINEL)
    headers:replace(NO_AUTH_MARKER, "1")
    return
  end
  if auth == PLACEHOLDER then
    headers:remove("authorization")
  end
end
