/**
 * Created by 烬云 on 2014/10/26.
 */

/*!
 * Module dependencies
 */
var state = require('state'),
  Q = require('q'),
  _ = require('lodash'),
  vm = require('vm'),
  assert = require('assert'),
  logger = require('log4js').getLogger('WorkflowInstance');

/**
 * @class WorkflowInstance
 * @inherits  {Item}
 */
module.exports = function (WorkflowInstance) {

  WorkflowInstance.validatesInclusionOf('workflowState', {in: ['Initial', 'Progressing', 'Completed', 'Canceled', 'Terminated']});

  /**
   * 启动工作流，返回创建的workflow-instance
   *
   * @param {any} initiator 流程启动者
   * @param {object} initialItem 流程启动项
   * @param {string}  initialItem.__t 流程启动项对应的模型
   * @param {any}  initialItem.id  流程启动项目id
   * @param {string}  initialItem.title  流程启动项目标题
   * @param {object} association  工作流关联
   * @param {any} association.id 工作流关联id
   * @param {object}  association.associatedData  工作流关联数据
   * @param {function}  callback
   * @return {promise}
   */
  WorkflowInstance.initialWorkflow = function (initiator, initialItem, association, callback) {
    return Q.async(function *() {
      assert(initiator, 'initiator is required');
      assert(association, 'association is required');

      var app = WorkflowInstance.app;
      initialItem = yield app.models[initialItem.__t].findById(initialItem.id);
      assert(initialItem, 'initialItem is required');
      if (initialItem.lk_workflow) {
        logger.info('initialItem: %s.%d has been locked', initialItem.__t, initialItem.id);
        var err = new Error('Workflow Locked');
        err.statusCode = 400;
        throw err;
      }
      association = yield app.models.WorkflowAssociation.findOne({
        where: {id: association.id},
        include: ['workflowTemplate']
      });

      assert(association, 'association is required');
      var wft = association.workflowTemplate();
      assert(wft, 'workflow template is not exist');
      var instance = yield WorkflowInstance.create({
        initiatorId: initiator,
        workflowList: initialItem.__t,
        workflowItemId: initialItem.id,
        workflowItemTitle: initialItem.title,
        workflowTemplateId: association.workflowTemplateId,
        script: wft.script,
        workflowAssociationId: association.id,
        associatedData: association.associatedData
      });
      logger.info('%s.%d created success', instance.__t, instance.id);
      var updatedItem = yield initialItem.updateAttributes({
        instanceId: instance.id,
        status: 'Pending',
        lk_workflow: true,
        //todo:确定是否更新
        //lk_update: true,
        lk_remove: true
      });
      logger.info('id:%s,%s.%s,status:%s,lk_workflow:%s', instance.id, updatedItem.__t, updatedItem.id, updatedItem.status, updatedItem.lk_workflow);
      var stateExpression = yield instance.stateExpression();
      state(instance, stateExpression);
      instance.state().go('Initial');
      return instance;
    })().nodeify(callback);
  };
  /**
   * 返回当前工作流实例的状态表达式
   *
   * @returns {promise}
   */
  WorkflowInstance.prototype.stateExpression = function () {
    var self = this;
    try {
      var initSandbox = {
        console: console,
        require: require,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        global: global,
        process: process,
        module: module,
        app: self.constructor.app,
        instance: self
      };
      var context = vm.createContext(initSandbox);
      var stateExpression = vm.runInContext(self.script, context);
      return Q(stateExpression);
    } catch (err) {
      return Q.reject(err);
    }
  };

  /**
   * 钝化至数据库
   *
   * @returns {promise}
   */
  WorkflowInstance.prototype.sleep = function (internalState) {
    var self = this;
    self.internalState = internalState || self.state().name;
    logger.info('id:%d sleep with state:%s', self.id, self.internalState);
    self.isWake = false;
    return self.save();
  };

  /**
   * 从数据库中取消持久化，并且传入任务
   * @function
   * @param {object} task  任务
   * @returns {promise}
   */
  WorkflowInstance.prototype.wakeUp = function (task) {
    var self = this;
    return Q.async(function *() {
      var stateExpression = yield self.stateExpression();
      state(self, stateExpression);
      var currentState = self.state(self.internalState);

      logger.info('id:%s wake up,internalState:%s,task.%s,changedMethod:%s', self.id, self.internalState, task.id, task.changedMethod);
      if (currentState) {
        if (currentState.hasMethod(task.changedMethod)) {
          self.state(self.internalState).call(task.changedMethod, task);
        } else {
          logger.error('id:%s,internalState:%s,task.%s,changedMethod:%s not found', self.id, self.internalState, task.id, task.changedMethod);
          yield self.workflowLogs.create({type: 'Error', body: 'Method ' + task.changedMethod + ' Not Found'});
        }
      } else {
        logger.error('id:%s,internalState:%s not found', self.id, self.internalState);
        yield self.workflowLogs.create({type: 'Error', body: 'State ' + task.changedMethod + ' Not Found'});
      }
    })();
  };

  /**
   * 得到流程启动项目
   *
   * @returns {promise}
   */
  WorkflowInstance.prototype.getInitialItem = function (filter) {
    var self = this;
    return WorkflowInstance.app.models[self.workflowList].findById(self.workflowItemId, filter);
  };

  /**
   * 更新流程启动项目
   *
   * @param {object} data  更新的k-v
   * @returns {promise}
   */
  WorkflowInstance.prototype.updateInitialItem = function (data) {
    var self = this;
    return Q.async(function *() {
      var item = yield self.getInitialItem();
      return yield item.updateAttributes(data);
    })();
  };

  /**
   * 获取当前工作流实例的所有任务
   *
   * @param {object} filter 过滤条件
   * @param {string} base 基础工作流类型，默认WorkflowTask
   * @return {promise}  工作流任务数组
   */
  WorkflowInstance.prototype.resolveTask = function (filter, base) {
    var self = this;
    filter = filter || {};
    filter = _.merge({where: {instanceId: self.id}}, filter);
    base = base || 'WorkflowTask';
    return Q.all(WorkflowInstance.app.models().filter(function (model) {
      return model.base.definition.name == base || model.definition.name == base;
    }).map(function (model) {
      return model.find(filter);
    })).then(function (taskArrs) {
      return taskArrs.reduce(function (memo, tks) {
        return memo.concat(tks);
      }, []);
    })
  };

  /**
   * 分配任务
   * @function
   * @param {object} task
   * @returns {promise}
   */
  WorkflowInstance.prototype.assignTask = function (task) {
    var self = this;
    return Q.async(function *() {
      var createdTask = yield WorkflowInstance.app.models[task.modelTo || 'WorkflowTask'].create(_.defaults({
        startDate: new Date(),
        creator: self.initiator,
        workflowAssociationId: self.workflowAssociationId,
        instanceId: self.id
      }, task));
      yield self.workflowLogs.create({type: 'Task Created', body: task.title});
      return createdTask;
    })();
  };

  /**
   * 将当前工作流实例中还没有完成的任务标记为关闭
   * @returns {promise}
   */
  WorkflowInstance.prototype.closeTask = function () {
    var self = this;
    return self.resolveTask({
      where: {
        status: {inq: ['Pending', 'Progressing']}
      }
    }).then(function (tasks) {
      return Q.all(tasks.map(function (task) {
        return task.updateAttributes({status: 'Closed'});
      }));
    });
  };

  /**
   * 取消工作流
   * 更新工作流实例状态
   * 更新相关联的任务
   * 取消流程启动项的工作流锁定
   *
   * @param callback
   * @returns {promise}
   */
  WorkflowInstance.prototype.cancel = function (callback) {
    var self = this;
    logger.info('id:%s,pre cancel,workflowState:%s', self.id, self.workflowState);
    return Q.async(function *() {
      //if (['Initial', 'Progressing', 'Terminated'].indexOf(self.workflowState) == -1) {
      //  var error = new Error('WorkflowInstance has been ' + self.workflowState);
      //  error.statusCode = 400;
      //  throw error;
      //}
      var expression = yield self.stateExpression();
      state(self, expression);
      var cancelState = self.state('Cancel');
      if (cancelState) {
        self.state().go('Cancel');
      } else {
        logger.warn('id:%s has not implement cancel state', self.id);
      }
      var canceledItem = yield self.updateInitialItem({lk_workflow: false});
      logger.info('%s.%s,lk_workflow:%s', self.workflowList, self.workflowItemId, canceledItem.lk_workflow);
      yield self.closeTask();
      logger.info('id:%s has close tasks', self.id);
      return yield self.updateAttributes({
        workflowState: 'Canceled',
        internalState: 'Cancel',
        completeAt: new Date()
      });
    })().nodeify(callback);
  };

  WorkflowInstance.prototype.finish = Q.async(function *(lock) {
    lock = _.defaults({lk_workflow: true}, lock)
    var inst = this;
    yield inst.updateInitialItem(lock);
    yield inst.updateAttributes({workflowState: 'Complted'})
  })();

  //remoteMethod

  WorkflowInstance.remoteMethod('initialWorkflow', {
    description: '启动工作流',
    accepts: [
      {
        arg: 'initiator', type: 'number', required: true,
        http: function (ctx) {
          return 1//ctx.req.accessToken.userId;
        },
        description: '流程启动者'
      },
      {
        arg: 'initialItem', type: 'object', required: true,
        description: [
          '流程启动项',
          'initialItem.id',
          'initialItem.__t',
          'initialItem.title'
        ].join('\r\n')
      },
      {
        arg: 'association', type: 'object', required: true,
        description: ['工作流关联'].join('\r\n')
      }
    ],
    returns: {arg: 'instance', type: 'object', root: true}
  });

  WorkflowInstance.remoteMethod('resolveTask', {
    description: '查找工作流相关的任务',
    isStatic: false,
    accepts: [
      {arg: 'filter', type: 'object', description: '过滤条件', default: {}},
      {arg: 'base', type: 'string', default: 'WorkflowTask'}
    ],
    http: {verb: 'get'},
    returns: {arg: 'tasks', type: 'array', root: true}
  });

  WorkflowInstance.remoteMethod('cancel', {
    description: '终止进行中或发生错误的工作流',
    isStatic: false,
    returns: {arg: 'instance', type: 'object', root: true}
  });


};
