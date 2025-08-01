package command

import (
	"time"

	"github.com/cslite/cslite/server/config"
	"github.com/cslite/cslite/server/models"
	"github.com/robfig/cron/v3"
	"github.com/sirupsen/logrus"
	"gorm.io/gorm"
)

type Scheduler struct {
	cron    *cron.Cron
	db      *gorm.DB
	service *Service
}

func NewScheduler() *Scheduler {
	return &Scheduler{
		cron:    cron.New(),
		db:      config.DB,
		service: NewService(),
	}
}

func (s *Scheduler) Start() error {
	_, err := s.cron.AddFunc("* * * * *", s.checkAndExecuteCommands)
	if err != nil {
		return err
	}

	s.cron.Start()
	logrus.Info("Command scheduler started")
	return nil
}

func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
	logrus.Info("Command scheduler stopped")
}

func (s *Scheduler) checkAndExecuteCommands() {
	now := time.Now()

	var onceCommands []models.Command
	s.db.Where("type = ? AND status = ?", models.CommandTypeOnce, models.CommandStatusPending).Find(&onceCommands)
	
	for _, cmd := range onceCommands {
		logrus.Infof("Executing once command: %s", cmd.ID)
		s.service.executeCommand(&cmd)
	}

	var cronCommands []models.Command
	s.db.Where("type = ? AND status IN ? AND next_run <= ?", 
		models.CommandTypeCron, 
		[]string{models.CommandStatusPending, models.CommandStatusRunning},
		now,
	).Find(&cronCommands)

	for _, cmd := range cronCommands {
		logrus.Infof("Executing cron command: %s", cmd.ID)
		s.service.executeCommand(&cmd)

		if nextRun, err := calculateNextRun(cmd.Schedule); err == nil {
			s.db.Model(&cmd).Update("next_run", nextRun)
		}
	}
}