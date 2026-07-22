local PLACEHOLDER = "Bearer sk-ant-oat-SANDBOX-PLACEHOLDER"

function envoy_on_request(request_handle)
  local auth = request_handle:headers():get("authorization")
  if auth == nil then
    return
  end
  if auth ~= PLACEHOLDER then
    request_handle:logInfo("sandbox: rejected credential len=" .. tostring(#auth) .. " prefix=" .. auth:sub(1, 24))
    request_handle:respond({[":status"] = "403"}, "sandbox: unexpected credential")
  end
end
