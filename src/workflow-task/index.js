/**
 * Created by Nemo on 15/5/13.
 */
module.exports = 'cmp.workflow.task';
angular.module('cmp.workflow.task', [
  require('./WorkflowApproveTask'),
  require('./ReassignTask'),
  require('./RequestChangeTask')
]).factory('WorkflowTaskUtil',require('./WorkflowUtil'))

