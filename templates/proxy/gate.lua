local PLACEHOLDER = "Bearer sk-ant-oat-SANDBOX-PLACEHOLDER"
local NO_AUTH_MARKER = "x-configamatron-no-auth"
local NO_AUTH_SENTINEL = "sandbox-no-credential"

function envoy_on_request(request_handle)
  local headers = request_handle:headers()
  headers:remove(NO_AUTH_MARKER)
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
