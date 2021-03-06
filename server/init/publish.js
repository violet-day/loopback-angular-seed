/**
 * Created by 烬云 on 2014/11/5.
 */
var Q = require('q'),
  _ = require('lodash'),
  colMap = require('../columns'),
  workflowMap = require('../workflow'),
  app = require('./../server');

Q.async(function *() {
  yield [
    app.models.ColumnDef.deleteAll(),
    app.models.List.deleteAll(),
    app.models.View.deleteAll(),
    app.models.WorkflowTemplate.deleteAll(),
    app.models.WorkflowAssociation.deleteAll()
  ];
  console.log('rest done');

  yield app.models.ColumnDef.create(colMap);
  console.log('create ColumnDef done');

  yield Q.all(workflowMap.map(function (wft) {
    return app.models.WorkflowTemplate.create(wft);
  }));
  console.log('create Workflow template done');

  yield Q.all(_.values(app.models).map(function (model) {
    return app.models.List.publish(model);
  }))
  console.log('publish list done');
})().catch(function (err) {
  console.error(err);
});

