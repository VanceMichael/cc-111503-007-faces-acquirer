# 来源接口与资料语义

本站为 Jakarta Faces partial-response 语义的受限查询接口。POST须带 Faces-Request:partial/ajax、jakarta.faces.partial.ajax=true、source、execute、render及提交表单的ViewState。响应XML支持changes/update(CDATA HTML)、delete、insert(before/after)、attributes、redirect和error；禁止DTD及任意eval，eval存在时整次变化不接受且留诊断。ViewState update id按表单前缀定位；不同表单不共享状态。响应完成且无error后才构成可采集视图；redirect会转入新视图，旧控件引用失效。fixture提供截断响应及两表单不同状态。

## 收件器扩展接口

现有 `src/intake.mjs` 导出 `preview(source, store)`，只做预览。收件器入口为新增的 `collect(source, store)`，由调用方负责创建和关闭来源及 Inbox。`npm run acceptance` 调用这一入口。返回的 `records` 是可正式交付资料，不把未确认片段放进该集合；特殊业务的 pending 和 diagnostics 独立返回。原始证据通过 Inbox 保存，正式记录应含证据引用。接口不规定内部架构，允许增加模块和持久表，但不能移除原预览或更改来源语义。

## 可观察边界

- 详情和联系人同时更新才输出机构
- 跨表单ViewState不可串用
- delete/insert/attributes改变有效控件
- XML截断或error不形成半份视图
- redirect后旧元素身份不继续复用

## 公开的结果字段

`acceptance/collection.test.mjs` 给出当前集成方使用的结果字段及最小示例，说明的是输出契约而非内部处理步骤。除这些示例外，以上来源语义也属于功能范围，不能靠场景名称分支返回固定答案。`status` 仅在对应资料闭合且可靠取得时为 complete。

## 查询顺序

机构行只在directory:search查询后的matches区域提供，行按钮有data-institution。展开时提交当前行按钮id作为jakarta.faces.source，不能沿用最初查询按钮。查询和展开各自返回新的ViewState；不同表单可同时变化。来源只接受当前一版状态，GET重新进入会开启新视图。XML解析可使用已锁定的saxes，HTML片段处理可使用parse5，不需要下载浏览器或执行返回脚本。
